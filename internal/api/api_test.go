package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
