package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/bry-guy/pi-sync/internal/lease"
	"github.com/bry-guy/pi-sync/internal/session"
	"github.com/bry-guy/pi-sync/internal/store"
)

func apiEnvelope() session.Envelope {
	return session.Envelope{
		FormatVersion:    session.FormatVersion,
		SessionID:        "session-1",
		PiSessionVersion: 3,
		CreatedAt:        "2026-01-01T00:00:00Z",
		HeadEntryID:      "a",
		Title:            "api",
		Entries: []json.RawMessage{
			json.RawMessage(`{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:01Z"}`),
		},
	}
}

func scopedAPIEnvelope(id, remote, branch string) session.Envelope {
	envelope := apiEnvelope()
	envelope.SessionID = id
	envelope.Workspace = &session.Workspace{GitRemote: remote, Branch: branch, Commit: "0123456789abcdef0123456789abcdef01234567"}
	return envelope
}

func TestHTTPRepositoryScope(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	server := New(filesystem, lease.New(nil, lease.DefaultExpiry))
	router := httptest.NewServer(server)
	defer router.Close()

	for _, envelope := range []session.Envelope{
		scopedAPIEnvelope("repo-a", "git@github.com:owner/repo.git", "main"),
		scopedAPIEnvelope("repo-a-branch", "https://github.com/owner/repo.git", "feature/other"),
		scopedAPIEnvelope("repo-b", "https://github.com/other/repo.git", "main"),
		apiEnvelope(),
	} {
		body, _ := json.Marshal(envelope)
		response, requestErr := http.Post(router.URL+"/v1/sessions", "application/json", bytes.NewReader(body))
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("create %s status = %d", envelope.SessionID, response.StatusCode)
		}
		response.Body.Close()
	}

	response, err := http.Get(router.URL + "/v1/sessions?repository=" + url.QueryEscape("git@github.com:owner/repo.git"))
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Sessions []struct {
			SessionID string `json:"sessionId"`
		} `json:"sessions"`
	}
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || len(listed.Sessions) != 2 {
		t.Fatalf("repository filter returned status %d and %d sessions", response.StatusCode, len(listed.Sessions))
	}

	response, err = http.Get(router.URL + "/v1/sessions?repository=none")
	if err != nil {
		t.Fatal(err)
	}
	listed.Sessions = nil
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || len(listed.Sessions) != 1 || listed.Sessions[0].SessionID != "session-1" {
		t.Fatalf("unscoped filter returned status %d and %d sessions", response.StatusCode, len(listed.Sessions))
	}

	request, _ := http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/repo-a/lease", bytes.NewReader([]byte(`{"holder":"a"}`)))
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("missing repository scope status = %d", response.StatusCode)
	}
	response.Body.Close()

	request, _ = http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/repo-a/lease", bytes.NewReader([]byte(`{"holder":"a","repository":"https://github.com/owner/repo.git"}`)))
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("equivalent repository scope status = %d", response.StatusCode)
	}
	var acquired struct {
		ETag  string `json:"etag"`
		Lease struct {
			Token string `json:"token"`
		} `json:"lease"`
	}
	if err := json.NewDecoder(response.Body).Decode(&acquired); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	request, _ = http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/repo-b/lease", bytes.NewReader([]byte(`{"holder":"b","repository":"github.com/owner/repo"}`)))
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("different repository scope status = %d", response.StatusCode)
	}
	response.Body.Close()

	updated := scopedAPIEnvelope("repo-a", "https://github.com/other/repo.git", "main")
	updatedBody, _ := json.Marshal(updated)
	request, _ = http.NewRequest(http.MethodPut, router.URL+"/v1/sessions/repo-a", bytes.NewReader(updatedBody))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Pi-Sync-Lease", acquired.Lease.Token)
	request.Header.Set("If-Match", acquired.ETag)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("scope-changing update status = %d", response.StatusCode)
	}
	response.Body.Close()

	request, _ = http.NewRequest(http.MethodDelete, router.URL+"/v1/sessions/repo-a/lease", nil)
	request.Header.Set("X-Pi-Sync-Lease", acquired.Lease.Token)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	request, _ = http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/session-1/lease", bytes.NewReader([]byte(`{"holder":"unscoped","repository":"none"}`)))
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unscoped repository scope status = %d", response.StatusCode)
	}
	var unscopedLease struct {
		ETag  string `json:"etag"`
		Lease struct {
			Token string `json:"token"`
		} `json:"lease"`
	}
	if err := json.NewDecoder(response.Body).Decode(&unscopedLease); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	updated = scopedAPIEnvelope("session-1", "https://github.com/owner/repo.git", "main")
	updatedBody, _ = json.Marshal(updated)
	request, _ = http.NewRequest(http.MethodPut, router.URL+"/v1/sessions/session-1", bytes.NewReader(updatedBody))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Pi-Sync-Lease", unscopedLease.Lease.Token)
	request.Header.Set("If-Match", unscopedLease.ETag)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("unscoped scope-changing update status = %d", response.StatusCode)
	}
	response.Body.Close()

	request, _ = http.NewRequest(http.MethodDelete, router.URL+"/v1/sessions/session-1/lease", nil)
	request.Header.Set("X-Pi-Sync-Lease", unscopedLease.Lease.Token)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}

func TestHTTPLeaseAndConditionalUpdate(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	server := New(filesystem, lease.New(nil, lease.DefaultExpiry))
	router := httptest.NewServer(server)
	defer router.Close()

	body, _ := json.Marshal(apiEnvelope())
	response, err := http.Post(router.URL+"/v1/sessions", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d", response.StatusCode)
	}
	var created struct {
		ETag string `json:"etag"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	request, _ := http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/session-1/lease", bytes.NewReader([]byte(`{"holder":"a"}`)))
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("acquire status = %d", response.StatusCode)
	}
	var acquired struct {
		ETag  string `json:"etag"`
		Lease struct {
			Token string `json:"token"`
		} `json:"lease"`
	}
	if err := json.NewDecoder(response.Body).Decode(&acquired); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if acquired.Lease.Token == "" || acquired.ETag != created.ETag {
		t.Fatal("acquire response missing token or ETag")
	}

	request, _ = http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/session-1/lease", bytes.NewReader([]byte(`{"holder":"b"}`)))
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusLocked {
		t.Fatalf("second acquire status = %d", response.StatusCode)
	}
	response.Body.Close()

	updated := apiEnvelope()
	updated.Title = "changed"
	updatedBody, _ := json.Marshal(updated)
	request, _ = http.NewRequest(http.MethodPut, router.URL+"/v1/sessions/session-1", bytes.NewReader(updatedBody))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Pi-Sync-Lease", acquired.Lease.Token)
	request.Header.Set("If-Match", acquired.ETag)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("update status = %d", response.StatusCode)
	}
	response.Body.Close()

	request, _ = http.NewRequest(http.MethodDelete, router.URL+"/v1/sessions/session-1/lease", nil)
	request.Header.Set("X-Pi-Sync-Lease", acquired.Lease.Token)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("release status = %d", response.StatusCode)
	}
	response.Body.Close()
}
