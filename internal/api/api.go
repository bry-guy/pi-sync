package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/bry-guy/pi-sync/internal/lease"
	"github.com/bry-guy/pi-sync/internal/session"
	"github.com/bry-guy/pi-sync/internal/store"
)

const (
	leaseHeader  = "X-Pi-Sync-Lease"
	maxHolderLen = 128
)

type Server struct {
	store  *store.Store
	leases *lease.Registry
}

func New(filesystem *store.Store, leases *lease.Registry) *Server {
	if leases == nil {
		leases = lease.New(lease.RealClock{}, lease.DefaultExpiry)
	}
	return &Server{store: filesystem, leases: leases}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/v1/health" {
		if r.Method != http.MethodGet {
			s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method is not supported", nil)
			return
		}
		s.writeHealth(w)
		return
	}
	if r.URL.Path == "/v1/sessions" {
		s.handleSessions(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/sessions/") {
		s.handleSession(w, r)
		return
	}
	s.writeError(w, http.StatusNotFound, "not_found", "resource not found", nil)
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		records, err := s.store.List()
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, "store_unavailable", "session store is unavailable", nil)
			return
		}
		sessions := make([]metadata, 0, len(records))
		for _, record := range records {
			sessions = append(sessions, s.metadata(record))
		}
		sort.Slice(sessions, func(i, j int) bool {
			return sessions[i].SessionID < sessions[j].SessionID
		})
		s.writeJSON(w, http.StatusOK, map[string]any{
			"formatVersion": session.FormatVersion,
			"sessions":      sessions,
		})
	case http.MethodPost:
		envelope, ok := s.readEnvelope(w, r)
		if !ok {
			return
		}
		record, err := s.store.Create(envelope)
		if err != nil {
			if errors.Is(err, store.ErrAlreadyExists) {
				s.writeError(w, http.StatusConflict, "duplicate_enrollment", "session is already enrolled", nil)
				return
			}
			if session.IsValidationError(err) {
				s.writeError(w, http.StatusBadRequest, "invalid_session", sanitizeError(err), nil)
				return
			}
			s.writeError(w, http.StatusInternalServerError, "store_unavailable", "session could not be stored", nil)
			return
		}
		w.Header().Set("ETag", record.ETag)
		s.writeJSON(w, http.StatusCreated, map[string]any{
			"formatVersion": session.FormatVersion,
			"session":       record.Envelope,
			"etag":          record.ETag,
		})
	default:
		w.Header().Set("Allow", "GET, POST")
		s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method is not supported", nil)
	}
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	id, operation, ok := parseSessionPath(r.URL.Path)
	if !ok {
		s.writeError(w, http.StatusNotFound, "not_found", "resource not found", nil)
		return
	}
	// A request to any session operation first verifies that the canonical file
	// exists. This keeps lease and update errors from revealing arbitrary paths.
	if _, err := s.store.Get(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.writeError(w, http.StatusNotFound, "session_not_found", "session was not found", nil)
			return
		}
		s.writeError(w, http.StatusInternalServerError, "store_unavailable", "session store is unavailable", nil)
		return
	}

	switch operation {
	case "session":
		if r.Method != http.MethodPut {
			w.Header().Set("Allow", "PUT")
			s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method is not supported", nil)
			return
		}
		s.update(w, r, id)
	case "lease":
		switch r.Method {
		case http.MethodPost:
			s.acquire(w, r, id)
		case http.MethodDelete:
			s.release(w, r, id)
		default:
			w.Header().Set("Allow", "POST, DELETE")
			s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method is not supported", nil)
		}
	case "lease/renew":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method is not supported", nil)
			return
		}
		s.renew(w, r, id)
	default:
		s.writeError(w, http.StatusNotFound, "not_found", "resource not found", nil)
	}
}

func (s *Server) acquire(w http.ResponseWriter, r *http.Request, id string) {
	var request struct {
		Holder string `json:"holder"`
	}
	if !s.readJSON(w, r, &request) {
		return
	}
	if len(request.Holder) > maxHolderLen || strings.ContainsAny(request.Holder, "\r\n\x00") {
		s.writeError(w, http.StatusBadRequest, "invalid_holder", "holder label is invalid", nil)
		return
	}
	record, err := s.store.Get(id)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	current, err := s.leases.Acquire(id, request.Holder)
	if err != nil {
		if lease.IsActive(err) {
			s.writeError(w, http.StatusLocked, "active_lease", "session is currently leased", map[string]any{
				"holder":    current.Holder,
				"expiresAt": current.ExpiresAt,
			})
			return
		}
		s.writeError(w, http.StatusInternalServerError, "lease_unavailable", "lease could not be acquired", nil)
		return
	}
	w.Header().Set("ETag", record.ETag)
	s.writeJSON(w, http.StatusOK, map[string]any{
		"formatVersion": session.FormatVersion,
		"session":       record.Envelope,
		"etag":          record.ETag,
		"lease":         leaseJSON(current, true),
	})
}

func (s *Server) renew(w http.ResponseWriter, r *http.Request, id string) {
	token := leaseToken(r)
	if token == "" {
		s.writeError(w, http.StatusLocked, "lease_required", "an active lease token is required", nil)
		return
	}
	current, err := s.leases.Renew(id, token)
	if err != nil {
		s.writeError(w, http.StatusLocked, "lease_invalid", "lease token is invalid or expired", nil)
		return
	}
	record, err := s.store.Get(id)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.Header().Set("ETag", record.ETag)
	s.writeJSON(w, http.StatusOK, map[string]any{
		"formatVersion": session.FormatVersion,
		"etag":          record.ETag,
		"lease":         leaseJSON(current, false),
	})
}

func (s *Server) release(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", "DELETE")
		s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method is not supported", nil)
		return
	}
	token := leaseToken(r)
	if token == "" {
		s.writeError(w, http.StatusBadRequest, "lease_required", "an active lease token is required", nil)
		return
	}
	if err := s.leases.Release(id, token); err != nil {
		if lease.IsNotFound(err) {
			s.writeError(w, http.StatusNotFound, "lease_not_found", "lease was not found", nil)
			return
		}
		s.writeError(w, http.StatusLocked, "lease_invalid", "lease token is invalid or expired", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) update(w http.ResponseWriter, r *http.Request, id string) {
	token := leaseToken(r)
	if token == "" {
		s.writeError(w, http.StatusLocked, "lease_required", "an active lease token is required", nil)
		return
	}
	if _, err := s.leases.Renew(id, token); err != nil {
		s.writeError(w, http.StatusLocked, "lease_invalid", "lease token is invalid or expired", nil)
		return
	}
	ifMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if ifMatch == "" {
		s.writeError(w, http.StatusPreconditionRequired, "etag_required", "If-Match is required", nil)
		return
	}
	envelope, ok := s.readEnvelope(w, r)
	if !ok {
		return
	}
	if envelope.SessionID != id {
		s.writeError(w, http.StatusBadRequest, "invalid_session", "envelope session id does not match URL", nil)
		return
	}
	record, err := s.store.Update(id, ifMatch, envelope)
	if err != nil {
		var stale *store.StaleETagError
		if errors.As(err, &stale) {
			s.writeError(w, http.StatusPreconditionFailed, "stale_etag", "canonical session changed", map[string]any{
				"currentEtag": stale.Current,
			})
			return
		}
		if session.IsValidationError(err) {
			s.writeError(w, http.StatusBadRequest, "invalid_session", sanitizeError(err), nil)
			return
		}
		s.writeStoreError(w, err)
		return
	}
	w.Header().Set("ETag", record.ETag)
	s.writeJSON(w, http.StatusOK, map[string]any{
		"formatVersion": session.FormatVersion,
		"session":       record.Envelope,
		"etag":          record.ETag,
	})
}

func (s *Server) metadata(record store.Record) metadata {
	value := metadata{
		SessionID:   record.Envelope.SessionID,
		Title:       record.Envelope.Title,
		CreatedAt:   record.Envelope.CreatedAt,
		HeadEntryID: record.Envelope.HeadEntryID,
		ETag:        record.ETag,
		Workspace:   record.Envelope.Workspace,
	}
	if current, ok := s.leases.Current(record.Envelope.SessionID); ok {
		value.LeaseHolder = &current.Holder
		value.LeaseExpiresAt = &current.ExpiresAt
	}
	return value
}

type metadata struct {
	SessionID      string             `json:"sessionId"`
	Title          string             `json:"title"`
	CreatedAt      string             `json:"createdAt"`
	HeadEntryID    string             `json:"headEntryId"`
	ETag           string             `json:"etag"`
	LeaseHolder    *string            `json:"leaseHolder"`
	LeaseExpiresAt *time.Time         `json:"leaseExpiresAt"`
	Workspace      *session.Workspace `json:"workspace,omitempty"`
}

type leaseResponse struct {
	Token      string    `json:"token,omitempty"`
	Holder     string    `json:"holder"`
	AcquiredAt time.Time `json:"acquiredAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

func leaseJSON(value lease.Lease, includeToken bool) leaseResponse {
	response := leaseResponse{Holder: value.Holder, AcquiredAt: value.AcquiredAt, ExpiresAt: value.ExpiresAt}
	if includeToken {
		response.Token = value.Token
	}
	return response
}

func parseSessionPath(path string) (string, string, bool) {
	const prefix = "/v1/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) < 1 || parts[0] == "" {
		return "", "", false
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil || !session.SafeID(id) {
		return "", "", false
	}
	if len(parts) == 1 {
		return id, "session", true
	}
	if len(parts) == 2 && parts[1] == "lease" {
		return id, "lease", true
	}
	if len(parts) == 3 && parts[1] == "lease" && parts[2] == "renew" {
		return id, "lease/renew", true
	}
	return "", "", false
}

func leaseToken(r *http.Request) string {
	for _, header := range []string{leaseHeader, "X-Pi-Sync-Lease-Token", "X-Lease-Token", "Lease-Token"} {
		if token := strings.TrimSpace(r.Header.Get(header)); token != "" {
			return token
		}
	}
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authorization) > 7 && strings.EqualFold(authorization[:7], "Bearer ") {
		return strings.TrimSpace(authorization[7:])
	}
	return ""
}

func (s *Server) readEnvelope(w http.ResponseWriter, r *http.Request) (session.Envelope, bool) {
	body := http.MaxBytesReader(w, r.Body, session.MaxEnvelopeBytes+1)
	data, err := io.ReadAll(body)
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			s.writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "request body is too large", nil)
		} else {
			s.writeError(w, http.StatusBadRequest, "invalid_request", "request body could not be read", nil)
		}
		return session.Envelope{}, false
	}
	if len(data) > session.MaxEnvelopeBytes {
		s.writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "request body is too large", nil)
		return session.Envelope{}, false
	}
	envelope, err := session.Decode(data)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid_session", sanitizeError(err), nil)
		return session.Envelope{}, false
	}
	return envelope, true
}

func (s *Server) readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "request body must be valid JSON", nil)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "request body contains trailing data", nil)
		return false
	}
	return true
}

func (s *Server) writeHealth(w http.ResponseWriter) {
	if _, err := s.store.List(); err != nil {
		s.writeError(w, http.StatusServiceUnavailable, "store_unavailable", "session store is unavailable", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"status":             "ok",
		"formatVersion":      session.FormatVersion,
		"heartbeatSeconds":   int(lease.DefaultHeartbeat / time.Second),
		"leaseExpirySeconds": int(lease.DefaultExpiry / time.Second),
	})
}

func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		s.writeError(w, http.StatusNotFound, "session_not_found", "session was not found", nil)
	case session.IsValidationError(err):
		s.writeError(w, http.StatusInternalServerError, "invalid_stored_session", "stored session is invalid", nil)
	default:
		s.writeError(w, http.StatusInternalServerError, "store_unavailable", "session store is unavailable", nil)
	}
}

func sanitizeError(err error) string {
	message := strings.TrimSpace(err.Error())
	if len(message) > 256 {
		message = message[:256]
	}
	if message == "" {
		return "invalid request"
	}
	return message
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, message string, details map[string]any) {
	payload := map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	}
	if details != nil {
		payload["error"].(map[string]any)["details"] = details
	}
	s.writeJSON(w, status, payload)
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	// The response may already have started, so there is no safe second error
	// response if the client disconnects during encoding.
	_ = json.NewEncoder(w).Encode(value)
}
