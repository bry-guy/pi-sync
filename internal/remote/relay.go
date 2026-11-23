package remote

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultHostTTL    = 35 * time.Second
	DefaultPollWait   = 20 * time.Second
	MaxPollWait       = 20 * time.Second
	DefaultRPCTimeout = 15 * time.Second
	SSEPingInterval   = 15 * time.Second
	maxRegisterBytes  = 256 << 10
	maxEventsBytes    = 2 << 20
	maxReplyBytes     = 16 << 20
	maxCommandBytes   = 10 << 20
	subscriberBufSize = 256
)

// SessionMeta describes a live remote-controlled session on a connected host.
type SessionMeta struct {
	SessionID       string          `json:"sessionId"`
	HostID          string          `json:"hostId"`
	Device          string          `json:"device"`
	Cwd             string          `json:"cwd"`
	Title           string          `json:"title,omitempty"`
	Model           string          `json:"model,omitempty"`
	ThinkingLevel   string          `json:"thinkingLevel,omitempty"`
	ThinkingLevels  []string        `json:"thinkingLevels,omitempty"`
	Context         json.RawMessage `json:"context,omitempty"`
	Streaming       bool            `json:"streaming"`
	WaitingDialog   string          `json:"waitingDialog,omitempty"`
	PendingQuestion json.RawMessage `json:"pendingQuestion,omitempty"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

// Command is an RPC request dispatched from a controller to the owning host.
type Command struct {
	ReqID     string          `json:"reqId"`
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"` // "transcript" | "message" | "stop" | "answer_question" | "set_thinking" | "set_model" | "close"
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type hostReply struct {
	HostID string          `json:"hostId"`
	ReqID  string          `json:"reqId"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type sseMessage struct {
	event string
	data  []byte
}

type subscriber struct {
	ch chan sseMessage
}

type hostState struct {
	id       string
	lastSeen time.Time
	polling  int
	sessions map[string]SessionMeta
	commands []Command
	notify   chan struct{}
}

type pendingRPC struct {
	hostID    string
	sessionID string
	reply     chan hostReply
}

// Relay is a stateless in-memory broker between laptop hosts and pi-web controllers.
// Nothing is persisted to disk; presence is derived strictly from active host polling.
type Relay struct {
	HostTTL    time.Duration
	RPCTimeout time.Duration
	PingEvery  time.Duration

	mu          sync.Mutex
	hosts       map[string]*hostState
	bySession   map[string]string // sessionId -> hostId
	pending     map[string]*pendingRPC
	subscribers map[*subscriber]struct{}
	stopCh      chan struct{}
	stopOnce    sync.Once
	now         func() time.Time
}

func New() *Relay {
	r := &Relay{
		HostTTL:     DefaultHostTTL,
		RPCTimeout:  DefaultRPCTimeout,
		PingEvery:   SSEPingInterval,
		hosts:       make(map[string]*hostState),
		bySession:   make(map[string]string),
		pending:     make(map[string]*pendingRPC),
		subscribers: make(map[*subscriber]struct{}),
		stopCh:      make(chan struct{}),
		now:         time.Now,
	}
	go r.reapLoop()
	return r
}

func (r *Relay) Close() {
	r.stopOnce.Do(func() { close(r.stopCh) })
}

func (r *Relay) reapLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.stopCh:
			return
		case <-ticker.C:
			r.Sweep()
		}
	}
}

// Sweep removes hosts whose last poll/activity exceeded HostTTL and fails their pending RPCs.
func (r *Relay) Sweep() {
	r.mu.Lock()
	now := r.now()
	ttl := r.HostTTL
	if ttl <= 0 {
		ttl = DefaultHostTTL
	}
	changed := false
	for hostID, h := range r.hosts {
		if h.polling > 0 || now.Sub(h.lastSeen) <= ttl {
			continue
		}
		changed = r.removeHostLocked(hostID) || changed
	}
	var snapshot []byte
	if changed {
		snapshot = r.sessionsEventLocked()
	}
	r.mu.Unlock()
	if snapshot != nil {
		r.broadcast(sseMessage{event: "sessions", data: snapshot})
	}
}

func (r *Relay) removeHostLocked(hostID string) bool {
	h, ok := r.hosts[hostID]
	if !ok {
		return false
	}
	hadSessions := len(h.sessions) > 0
	for sid := range h.sessions {
		if r.bySession[sid] == hostID {
			delete(r.bySession, sid)
		}
	}
	delete(r.hosts, hostID)
	for reqID, p := range r.pending {
		if p.hostID == hostID {
			delete(r.pending, reqID)
			select {
			case p.reply <- hostReply{Status: http.StatusServiceUnavailable, Body: errJSON("host_offline", "remote host disconnected")}:
			default:
			}
		}
	}
	return hadSessions
}

// ServeHTTP handles all /v1/remote/* routes with split credentials:
//   - If remoteToken is empty, every /v1/remote/* route fails closed with 404.
//   - /v1/remote/host/* requires syncToken (when non-empty).
//   - Controller routes (/v1/remote/sessions, /v1/remote/events, /v1/remote/sessions/:id/*) require remoteToken.
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request, syncToken, remoteToken string) {
	if remoteToken == "" {
		writeErr(w, http.StatusNotFound, "not_found", "remote control is not enabled")
		return
	}
	path := req.URL.Path
	if strings.HasPrefix(path, "/v1/remote/host/") {
		if syncToken != "" && !bearerMatch(req.Header.Get("Authorization"), syncToken) {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "a valid sync token is required")
			return
		}
		r.serveHost(w, req)
		return
	}
	if !bearerMatch(req.Header.Get("Authorization"), remoteToken) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "a valid remote control token is required")
		return
	}
	r.serveController(w, req)
}

func (r *Relay) serveHost(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path
	switch {
	case path == "/v1/remote/host/register" && req.Method == http.MethodPost:
		r.handleHostRegister(w, req)
	case path == "/v1/remote/host/poll" && req.Method == http.MethodGet:
		r.handleHostPoll(w, req)
	case path == "/v1/remote/host/events" && req.Method == http.MethodPost:
		r.handleHostEvents(w, req)
	case path == "/v1/remote/host/reply" && req.Method == http.MethodPost:
		r.handleHostReply(w, req)
	case strings.HasPrefix(path, "/v1/remote/host/sessions/") && req.Method == http.MethodDelete:
		r.handleHostUnregister(w, req)
	default:
		writeErr(w, http.StatusNotFound, "not_found", "resource not found")
	}
}

func (r *Relay) serveController(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path
	switch {
	case path == "/v1/remote/sessions" && req.Method == http.MethodGet:
		r.handleListSessions(w)
	case path == "/v1/remote/events" && req.Method == http.MethodGet:
		r.handleControllerEvents(w, req)
	case strings.HasPrefix(path, "/v1/remote/sessions/"):
		r.handleControllerSession(w, req)
	default:
		writeErr(w, http.StatusNotFound, "not_found", "resource not found")
	}
}

func (r *Relay) handleHostRegister(w http.ResponseWriter, req *http.Request) {
	body, ok := readBody(w, req, maxRegisterBytes)
	if !ok {
		return
	}
	var meta SessionMeta
	if err := json.Unmarshal(body, &meta); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json", "invalid registration payload")
		return
	}
	meta.SessionID = strings.TrimSpace(meta.SessionID)
	meta.HostID = strings.TrimSpace(meta.HostID)
	meta.Device = strings.TrimSpace(meta.Device)
	if meta.SessionID == "" || meta.HostID == "" || meta.Device == "" {
		writeErr(w, http.StatusBadRequest, "invalid_registration", "sessionId, hostId, and device are required")
		return
	}
	meta.UpdatedAt = r.now().UTC()

	r.mu.Lock()
	if owner, exists := r.bySession[meta.SessionID]; exists && owner != meta.HostID {
		r.mu.Unlock()
		writeErr(w, http.StatusConflict, "session_conflict", "session is already owned by another live host")
		return
	}
	h := r.ensureHostLocked(meta.HostID)
	h.lastSeen = r.now()
	h.sessions[meta.SessionID] = meta
	r.bySession[meta.SessionID] = meta.HostID
	snapshot := r.sessionsEventLocked()
	r.mu.Unlock()

	r.broadcast(sseMessage{event: "sessions", data: snapshot})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": meta})
}

func (r *Relay) handleHostUnregister(w http.ResponseWriter, req *http.Request) {
	sessionID := strings.TrimPrefix(req.URL.Path, "/v1/remote/host/sessions/")
	hostID := strings.TrimSpace(req.URL.Query().Get("hostId"))
	if sessionID == "" || hostID == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "sessionId and hostId are required")
		return
	}
	r.mu.Lock()
	var snapshot []byte
	if owner, ok := r.bySession[sessionID]; ok && owner == hostID {
		delete(r.bySession, sessionID)
		if h, exists := r.hosts[hostID]; exists {
			delete(h.sessions, sessionID)
			if len(h.sessions) == 0 && h.polling == 0 {
				delete(r.hosts, hostID)
			}
		}
		for reqID, p := range r.pending {
			if p.sessionID == sessionID {
				delete(r.pending, reqID)
				select {
				case p.reply <- hostReply{Status: http.StatusServiceUnavailable, Body: errJSON("host_offline", "remote session closed")}:
				default:
				}
			}
		}
		snapshot = r.sessionsEventLocked()
	}
	r.mu.Unlock()
	if snapshot != nil {
		r.broadcast(sseMessage{event: "sessions", data: snapshot})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (r *Relay) handleHostPoll(w http.ResponseWriter, req *http.Request) {
	hostID := strings.TrimSpace(req.URL.Query().Get("hostId"))
	if hostID == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "hostId is required")
		return
	}
	wait := DefaultPollWait
	if raw := req.URL.Query().Get("wait"); raw != "" {
		if secs, err := strconv.Atoi(raw); err == nil && secs > 0 {
			wait = time.Duration(secs) * time.Second
			if wait > MaxPollWait {
				wait = MaxPollWait
			}
		}
	}

	r.mu.Lock()
	h := r.ensureHostLocked(hostID)
	h.lastSeen = r.now()
	if len(h.commands) > 0 {
		cmds := h.commands
		h.commands = nil
		r.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"commands": cmds})
		return
	}
	h.polling++
	notify := h.notify
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		if cur, ok := r.hosts[hostID]; ok {
			cur.polling--
			cur.lastSeen = r.now()
		}
		r.mu.Unlock()
	}()

	timer := time.NewTimer(wait)
	defer timer.Stop()

	select {
	case <-notify:
	case <-timer.C:
	case <-req.Context().Done():
		return
	case <-r.stopCh:
	}

	r.mu.Lock()
	var cmds []Command
	if cur, ok := r.hosts[hostID]; ok && len(cur.commands) > 0 {
		cmds = cur.commands
		cur.commands = nil
	}
	r.mu.Unlock()
	if cmds == nil {
		cmds = []Command{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": cmds})
}

func (r *Relay) handleHostEvents(w http.ResponseWriter, req *http.Request) {
	body, ok := readBody(w, req, maxEventsBytes)
	if !ok {
		return
	}
	var payload struct {
		HostID    string            `json:"hostId"`
		SessionID string            `json:"sessionId"`
		Events    []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json", "invalid events payload")
		return
	}
	r.mu.Lock()
	owner, exists := r.bySession[payload.SessionID]
	if !exists || owner != payload.HostID {
		r.mu.Unlock()
		writeErr(w, http.StatusNotFound, "session_not_registered", "session is not registered for this host")
		return
	}
	if h, ok := r.hosts[payload.HostID]; ok {
		h.lastSeen = r.now()
	}
	r.mu.Unlock()

	for _, evt := range payload.Events {
		envelope, err := json.Marshal(struct {
			SessionID string          `json:"sessionId"`
			Event     json.RawMessage `json:"event"`
		}{SessionID: payload.SessionID, Event: evt})
		if err != nil {
			continue
		}
		r.broadcast(sseMessage{event: "session_event", data: envelope})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (r *Relay) handleHostReply(w http.ResponseWriter, req *http.Request) {
	body, ok := readBody(w, req, maxReplyBytes)
	if !ok {
		return
	}
	var reply hostReply
	if err := json.Unmarshal(body, &reply); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json", "invalid reply payload")
		return
	}
	r.mu.Lock()
	p, exists := r.pending[reply.ReqID]
	if exists && p.hostID == reply.HostID {
		delete(r.pending, reply.ReqID)
	} else {
		p = nil
	}
	if h, ok := r.hosts[reply.HostID]; ok {
		h.lastSeen = r.now()
	}
	r.mu.Unlock()
	if p != nil {
		if reply.Status == 0 {
			reply.Status = http.StatusOK
		}
		select {
		case p.reply <- reply:
		default:
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (r *Relay) handleListSessions(w http.ResponseWriter) {
	r.mu.Lock()
	sessions := r.listSessionsLocked()
	r.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (r *Relay) handleControllerEvents(w http.ResponseWriter, req *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming_unsupported", "streaming is not supported")
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	sub := &subscriber{ch: make(chan sseMessage, subscriberBufSize)}
	r.mu.Lock()
	r.subscribers[sub] = struct{}{}
	initial := r.sessionsEventLocked()
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		delete(r.subscribers, sub)
		r.mu.Unlock()
	}()

	writeSSE(w, "sessions", initial)
	flusher.Flush()

	pingEvery := r.PingEvery
	if pingEvery <= 0 {
		pingEvery = SSEPingInterval
	}
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()

	for {
		select {
		case <-req.Context().Done():
			return
		case <-r.stopCh:
			return
		case <-ticker.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case msg := <-sub.ch:
			if err := writeSSE(w, msg.event, msg.data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (r *Relay) handleControllerSession(w http.ResponseWriter, req *http.Request) {
	rest := strings.TrimPrefix(req.URL.Path, "/v1/remote/sessions/")
	parts := strings.Split(rest, "/")
	if len(parts) < 2 || parts[0] == "" {
		writeErr(w, http.StatusNotFound, "not_found", "resource not found")
		return
	}
	sessionID := parts[0]
	action := parts[1]

	switch {
	case action == "transcript" && len(parts) == 2 && req.Method == http.MethodGet:
		r.dispatchRPC(w, req.Context(), sessionID, "transcript", nil)
	case action == "message" && len(parts) == 2 && req.Method == http.MethodPost:
		body, ok := readBody(w, req, maxCommandBytes)
		if !ok {
			return
		}
		if !json.Valid(body) {
			writeErr(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		r.dispatchRPC(w, req.Context(), sessionID, "message", body)
	case action == "stop" && len(parts) == 2 && req.Method == http.MethodPost:
		r.dispatchRPC(w, req.Context(), sessionID, "stop", nil)
	case action == "close" && len(parts) == 2 && req.Method == http.MethodPost:
		r.dispatchRPC(w, req.Context(), sessionID, "close", nil)
	case action == "thinking" && len(parts) == 2 && req.Method == http.MethodPost:
		body, ok := readBody(w, req, maxRegisterBytes)
		if !ok {
			return
		}
		if !json.Valid(body) {
			writeErr(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		r.dispatchRPC(w, req.Context(), sessionID, "set_thinking", body)
	case action == "model" && len(parts) == 2 && req.Method == http.MethodPost:
		body, ok := readBody(w, req, maxRegisterBytes)
		if !ok {
			return
		}
		if !json.Valid(body) {
			writeErr(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		r.dispatchRPC(w, req.Context(), sessionID, "set_model", body)
	case action == "extension-ui" && len(parts) == 3 && parts[2] != "" && req.Method == http.MethodPost:
		body, ok := readBody(w, req, maxRegisterBytes)
		if !ok {
			return
		}
		if len(body) == 0 {
			body = []byte("{}")
		}
		if !json.Valid(body) {
			writeErr(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		wrapped, _ := json.Marshal(struct {
			RequestID string          `json:"requestId"`
			Body      json.RawMessage `json:"body"`
		}{RequestID: parts[2], Body: body})
		r.dispatchRPC(w, req.Context(), sessionID, "answer_question", wrapped)
	default:
		writeErr(w, http.StatusNotFound, "not_found", "resource not found")
	}
}

func (r *Relay) dispatchRPC(w http.ResponseWriter, ctx context.Context, sessionID, cmdType string, payload json.RawMessage) {
	reqID := newReqID()
	r.mu.Lock()
	hostID, ok := r.bySession[sessionID]
	if !ok {
		r.mu.Unlock()
		writeErr(w, http.StatusNotFound, "host_offline", "remote session is not connected")
		return
	}
	h, ok := r.hosts[hostID]
	if !ok {
		delete(r.bySession, sessionID)
		r.mu.Unlock()
		writeErr(w, http.StatusNotFound, "host_offline", "remote host is not connected")
		return
	}
	pending := &pendingRPC{
		hostID:    hostID,
		sessionID: sessionID,
		reply:     make(chan hostReply, 1),
	}
	r.pending[reqID] = pending
	h.commands = append(h.commands, Command{
		ReqID:     reqID,
		SessionID: sessionID,
		Type:      cmdType,
		Payload:   payload,
	})
	close(h.notify)
	h.notify = make(chan struct{})
	r.mu.Unlock()

	timeout := r.RPCTimeout
	if timeout <= 0 {
		timeout = DefaultRPCTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case rep := <-pending.reply:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rep.Status)
		if len(rep.Body) > 0 {
			_, _ = w.Write(rep.Body)
		} else {
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	case <-timer.C:
		r.mu.Lock()
		delete(r.pending, reqID)
		r.mu.Unlock()
		writeErr(w, http.StatusGatewayTimeout, "host_timeout", "remote host did not answer in time")
	case <-ctx.Done():
		r.mu.Lock()
		delete(r.pending, reqID)
		r.mu.Unlock()
	}
}

func (r *Relay) ensureHostLocked(hostID string) *hostState {
	h, ok := r.hosts[hostID]
	if !ok {
		h = &hostState{
			id:       hostID,
			lastSeen: r.now(),
			sessions: make(map[string]SessionMeta),
			notify:   make(chan struct{}),
		}
		r.hosts[hostID] = h
	}
	return h
}

func (r *Relay) listSessionsLocked() []SessionMeta {
	sessions := make([]SessionMeta, 0, len(r.bySession))
	for sid, hostID := range r.bySession {
		if h, ok := r.hosts[hostID]; ok {
			if meta, exists := h.sessions[sid]; exists {
				sessions = append(sessions, meta)
			}
		}
	}
	sort.Slice(sessions, func(i, j int) bool {
		if !sessions[i].UpdatedAt.Equal(sessions[j].UpdatedAt) {
			return sessions[i].UpdatedAt.After(sessions[j].UpdatedAt)
		}
		return sessions[i].SessionID < sessions[j].SessionID
	})
	return sessions
}

func (r *Relay) sessionsEventLocked() []byte {
	data, _ := json.Marshal(map[string]any{"sessions": r.listSessionsLocked()})
	return data
}

func (r *Relay) broadcast(msg sseMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for sub := range r.subscribers {
		select {
		case sub.ch <- msg:
		default:
			// Drain and enqueue a resync signal so slow controllers reload instead of stalling hosts.
			for len(sub.ch) > 0 {
				<-sub.ch
			}
			select {
			case sub.ch <- sseMessage{event: "resync", data: []byte("{}")}:
			default:
			}
		}
	}
}

func bearerMatch(header, token string) bool {
	return subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+token)) == 1
}

func newReqID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func readBody(w http.ResponseWriter, req *http.Request, limit int64) ([]byte, bool) {
	defer req.Body.Close()
	body, err := io.ReadAll(io.LimitReader(req.Body, limit+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read_failed", "could not read request body")
		return nil, false
	}
	if int64(len(body)) > limit {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds size limit")
		return nil, false
	}
	return body, true
}

func errJSON(code, message string) json.RawMessage {
	data, _ := json.Marshal(map[string]string{"error": code, "message": message})
	return data
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(errJSON(code, message))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeSSE(w io.Writer, event string, data []byte) error {
	if _, err := io.WriteString(w, "event: "+event+"\ndata: "); err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	_, err := io.WriteString(w, "\n\n")
	return err
}
