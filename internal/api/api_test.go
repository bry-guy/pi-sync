package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

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

func TestHealthReportsBuildID(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	previous := BuildID
	BuildID = "0123456789abcdef0123456789abcdef01234567"
	defer func() { BuildID = previous }()
	router := httptest.NewServer(New(filesystem, nil))
	defer router.Close()

	response, err := http.Get(router.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var health map[string]any
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || health["buildId"] != BuildID || health["status"] != "ok" || health["formatVersion"] == nil {
		t.Fatalf("health status %d body %v", response.StatusCode, health)
	}
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

	request, _ := http.NewRequest(http.MethodPost, router.URL+"/v1/sessions/repo-a/lease", bytes.NewReader([]byte(`{"holder":"a","repository":"https://github.com/owner/repo.git"}`)))
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
	// Repository scope is advisory, so an upstream change is an ordinary update.
	if response.StatusCode != http.StatusOK {
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
	if response.StatusCode != http.StatusOK {
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

func TestHTTPSnapshotWithoutLease(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	router := httptest.NewServer(New(filesystem, lease.New(nil, lease.DefaultExpiry)))
	defer router.Close()
	body, _ := json.Marshal(apiEnvelope())
	created, err := http.Post(router.URL+"/v1/sessions", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	created.Body.Close()

	response, err := http.Get(router.URL + "/v1/sessions/session-1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var snapshot struct {
		ETag    string `json:"etag"`
		Session struct {
			SessionID string `json:"sessionId"`
		} `json:"session"`
	}
	if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || snapshot.Session.SessionID != "session-1" || snapshot.ETag == "" || response.Header.Get("ETag") != snapshot.ETag {
		t.Fatalf("snapshot status %d etag %q session %q", response.StatusCode, snapshot.ETag, snapshot.Session.SessionID)
	}
	listed, err := http.Get(router.URL + "/v1/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer listed.Body.Close()
	var list struct {
		Sessions []struct {
			LeaseHolder *string `json:"leaseHolder"`
			UpdatedAt   string  `json:"updatedAt"`
		} `json:"sessions"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Sessions) != 1 || list.Sessions[0].LeaseHolder != nil || list.Sessions[0].UpdatedAt == "" {
		t.Fatalf("snapshot must not lease and list must report updatedAt: %+v", list.Sessions)
	}
}

func TestHTTPTakeOverInvalidatesPreviousHolder(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	router := httptest.NewServer(New(filesystem, lease.New(nil, lease.DefaultExpiry)))
	defer router.Close()
	body, _ := json.Marshal(apiEnvelope())
	created, err := http.Post(router.URL+"/v1/sessions", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	acquire := func(payload string) (int, string, string) {
		response, err := http.Post(router.URL+"/v1/sessions/session-1/lease", "application/json", bytes.NewReader([]byte(payload)))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result struct {
			ETag  string `json:"etag"`
			Lease struct {
				Token string `json:"token"`
			} `json:"lease"`
		}
		_ = json.NewDecoder(response.Body).Decode(&result)
		return response.StatusCode, result.Lease.Token, result.ETag
	}
	if status, _, _ := acquire(`{"holder":"laptop"}`); status != http.StatusOK {
		t.Fatalf("first acquire = %d", status)
	}
	if status, _, _ := acquire(`{"holder":"desktop"}`); status != http.StatusLocked {
		t.Fatalf("plain acquire while held = %d", status)
	}
	status, token, etag := acquire(`{"holder":"desktop","takeOver":true}`)
	if status != http.StatusOK || token == "" {
		t.Fatalf("take over = %d", status)
	}
	// The sleeping holder's token no longer works, so its late upload cannot overwrite.
	request, _ := http.NewRequest(http.MethodPut, router.URL+"/v1/sessions/session-1", bytes.NewReader(body))
	request.Header.Set("X-Pi-Sync-Lease", "stale-token")
	request.Header.Set("If-Match", etag)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusLocked {
		t.Fatalf("stale holder upload = %d", response.StatusCode)
	}
}

func TestHTTPAppendAndPagedEntries(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	router := httptest.NewServer(New(filesystem, lease.New(nil, lease.DefaultExpiry)))
	defer router.Close()
	call := func(method, path string, body any, headers map[string]string) (int, map[string]any) {
		var reader *bytes.Reader
		if body != nil {
			data, _ := json.Marshal(body)
			reader = bytes.NewReader(data)
		} else {
			reader = bytes.NewReader(nil)
		}
		request, _ := http.NewRequest(method, router.URL+path, reader)
		request.Header.Set("Content-Type", "application/json")
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var decoded map[string]any
		_ = json.NewDecoder(response.Body).Decode(&decoded)
		return response.StatusCode, decoded
	}
	status, created := call("POST", "/v1/sessions", apiEnvelope(), nil)
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("create %d", status)
	}
	etag := created["etag"].(string)
	head := apiEnvelope().HeadEntryID
	next := json.RawMessage(fmt.Sprintf(`{"type":"message","id":"n1","parentId":%q,"timestamp":"2026-01-01T00:00:09Z"}`, head))
	appendBody := map[string]any{"baseCount": 1, "entries": []json.RawMessage{next}, "headEntryId": "n1", "title": "t"}

	if status, _ := call("POST", "/v1/sessions/session-1/entries", appendBody, map[string]string{"If-Match": etag}); status != http.StatusLocked {
		t.Fatalf("append without a lease: %d", status)
	}
	status, acquired := call("POST", "/v1/sessions/session-1/lease?entries=none", map[string]any{"holder": "a"}, nil)
	if status != http.StatusOK || len(acquired["session"].(map[string]any)["entries"].([]any)) != 0 || acquired["count"].(float64) != 1 {
		t.Fatalf("metadata-only acquire: %d %v", status, acquired)
	}
	token := acquired["lease"].(map[string]any)["token"].(string)
	lease := map[string]string{"X-Pi-Sync-Lease": token, "If-Match": etag}
	status, appended := call("POST", "/v1/sessions/session-1/entries", appendBody, lease)
	if status != http.StatusOK || appended["count"].(float64) != 2 {
		t.Fatalf("append: %d %v", status, appended)
	}
	if status, _ := call("POST", "/v1/sessions/session-1/entries", appendBody, lease); status != http.StatusPreconditionFailed {
		t.Fatalf("replaying an append with the old etag: %d", status)
	}
	if status, _ := call("GET", "/v1/sessions/session-1/entries?from=1&prevId=wrong", nil, nil); status != http.StatusConflict {
		t.Fatalf("wrong predecessor: %d", status)
	}
	status, page := call("GET", "/v1/sessions/session-1/entries?from=1&prevId=a", nil, nil)
	if status != http.StatusOK || page["complete"] != true || page["prevId"] != "a" || len(page["session"].(map[string]any)["entries"].([]any)) != 1 || page["etag"] != appended["etag"] {
		t.Fatalf("entries from 1: %d %v", status, page)
	}
	if status, _ := call("GET", "/v1/sessions/session-1/entries?from=9", nil, nil); status != http.StatusConflict {
		t.Fatalf("from past the end: %d", status)
	}
	// Older clients still read and write the whole conversation.
	status, full := call("GET", "/v1/sessions/session-1", nil, nil)
	if status != http.StatusOK || len(full["session"].(map[string]any)["entries"].([]any)) != 2 {
		t.Fatalf("full get: %d", status)
	}
}

func TestHTTPWaitReturnsWhenTheLeaseHolderChanges(t *testing.T) {
	filesystem, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	leases := lease.New(nil, lease.DefaultExpiry)
	router := httptest.NewServer(New(filesystem, leases))
	defer router.Close()
	body, _ := json.Marshal(apiEnvelope())
	created, err := http.Post(router.URL+"/v1/sessions", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var made struct {
		ETag string `json:"etag"`
	}
	_ = json.NewDecoder(created.Body).Decode(&made)
	created.Body.Close()

	go func() {
		time.Sleep(300 * time.Millisecond)
		_, _ = leases.Acquire("session-1", "laptop")
	}()
	started := time.Now()
	response, err := http.Get(router.URL + "/v1/sessions/session-1/wait?etag=" + url.QueryEscape(made.ETag))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state struct {
		ETag        string `json:"etag"`
		LeaseHolder string `json:"leaseHolder"`
		Changed     bool   `json:"changed"`
	}
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	if !state.Changed || state.LeaseHolder != "laptop" || state.ETag != made.ETag || elapsed < 250*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("wait returned %+v after %s", state, elapsed)
	}
}
