package remote

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T, syncToken, remoteToken string) (*Relay, *httptest.Server) {
	t.Helper()
	relay := New()
	relay.RPCTimeout = 2 * time.Second
	relay.HostTTL = 100 * time.Millisecond
	relay.PingEvery = 10 * time.Second
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		relay.ServeHTTP(w, r, syncToken, remoteToken)
	}))
	t.Cleanup(func() {
		srv.Close()
		relay.Close()
	})
	return relay, srv
}

func doReq(t *testing.T, method, url, token string, body any) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, url, &buf)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestRemoteFailClosedAndTokenSeparation(t *testing.T) {
	_, disabled := newTestServer(t, "sync-tok", "")
	for _, tc := range []struct{ method, path, tok string }{
		{"GET", "/v1/remote/sessions", "sync-tok"},
		{"POST", "/v1/remote/host/register", "sync-tok"},
	} {
		res := doReq(t, tc.method, disabled.URL+tc.path, tc.tok, nil)
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s %s without RemoteToken: got %d, want 404", tc.method, tc.path, res.StatusCode)
		}
	}

	_, srv := newTestServer(t, "sync-tok", "ctrl-tok")
	// Sync token must NOT authorize controller routes.
	res := doReq(t, "GET", srv.URL+"/v1/remote/sessions", "sync-tok", nil)
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("sync token on controller route: got %d, want 401", res.StatusCode)
	}
	// Remote token must NOT authorize host routes when sync token is set.
	res = doReq(t, "POST", srv.URL+"/v1/remote/host/register", "ctrl-tok", map[string]any{"sessionId": "s1", "hostId": "h1", "device": "mac"})
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("remote token on host route: got %d, want 401", res.StatusCode)
	}
	// Correct tokens succeed.
	res = doReq(t, "POST", srv.URL+"/v1/remote/host/register", "sync-tok", map[string]any{"sessionId": "s1", "hostId": "h1", "device": "mac", "cwd": "/Users/brain"})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host register with sync token: got %d", res.StatusCode)
	}
	// Another host cannot hijack an already-registered sessionId.
	res = doReq(t, "POST", srv.URL+"/v1/remote/host/register", "sync-tok", map[string]any{"sessionId": "s1", "hostId": "h2", "device": "evil"})
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("conflicting host register: got %d, want 409", res.StatusCode)
	}
	res = doReq(t, "GET", srv.URL+"/v1/remote/sessions", "ctrl-tok", nil)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("controller list: got %d", res.StatusCode)
	}
	var listed struct {
		Sessions []SessionMeta `json:"sessions"`
	}
	if err := json.NewDecoder(res.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Sessions) != 1 || listed.Sessions[0].SessionID != "s1" || listed.Sessions[0].Device != "mac" {
		t.Fatalf("unexpected listed sessions: %+v", listed.Sessions)
	}
}

func TestRemoteRPCRoundTripAndEvents(t *testing.T) {
	relay, srv := newTestServer(t, "sync-tok", "ctrl-tok")
	relay.HostTTL = 5 * time.Second

	// Register host session.
	res := doReq(t, "POST", srv.URL+"/v1/remote/host/register", "sync-tok", map[string]any{
		"sessionId": "s1", "hostId": "h1", "device": "macbook", "cwd": "/Users/brain", "title": "Scratch",
	})
	res.Body.Close()

	// Subscribe to controller SSE events.
	sseCtx, cancelSSE := context.WithCancel(context.Background())
	defer cancelSSE()
	sseReq, _ := http.NewRequestWithContext(sseCtx, "GET", srv.URL+"/v1/remote/events", nil)
	sseReq.Header.Set("Authorization", "Bearer ctrl-tok")
	sseRes, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatal(err)
	}
	defer sseRes.Body.Close()

	reader := bufio.NewReader(sseRes.Body)
	readEvent := func() (string, string) {
		var evt, data string
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("sse read: %v", err)
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if evt != "" || data != "" {
					return evt, data
				}
				continue
			}
			if strings.HasPrefix(line, "event: ") {
				evt = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
	}

	ev, data := readEvent()
	if ev != "sessions" || !strings.Contains(data, `"s1"`) {
		t.Fatalf("initial SSE event = (%q, %q)", ev, data)
	}

	// Host pushes an event; controller receives it over SSE.
	res = doReq(t, "POST", srv.URL+"/v1/remote/host/events", "sync-tok", map[string]any{
		"hostId": "h1", "sessionId": "s1",
		"events": []any{map[string]any{"type": "text_delta", "delta": "hi"}},
	})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host events: got %d", res.StatusCode)
	}
	ev, data = readEvent()
	if ev != "session_event" || !strings.Contains(data, `"text_delta"`) {
		t.Fatalf("pushed SSE event = (%q, %q)", ev, data)
	}

	// Start host poll loop in background to answer RPCs.
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for range 2 {
			pollRes := doReq(t, "GET", srv.URL+"/v1/remote/host/poll?hostId=h1&wait=5", "sync-tok", nil)
			var body struct {
				Commands []Command `json:"commands"`
			}
			err := json.NewDecoder(pollRes.Body).Decode(&body)
			pollRes.Body.Close()
			if err != nil {
				return
			}
			for _, cmd := range body.Commands {
				rep := doReq(t, "POST", srv.URL+"/v1/remote/host/reply", "sync-tok", map[string]any{
					"hostId": "h1",
					"reqId":  cmd.ReqID,
					"status": http.StatusOK,
					"body":   map[string]any{"ok": true, "echo": cmd.Type},
				})
				rep.Body.Close()
			}
		}
	}()

	// Controller sends message RPC; waits for synchronous host ack.
	msgRes := doReq(t, "POST", srv.URL+"/v1/remote/sessions/s1/message", "ctrl-tok", map[string]any{"text": "hello", "clientMessageId": "m1"})
	defer msgRes.Body.Close()
	if msgRes.StatusCode != http.StatusOK {
		t.Fatalf("controller message rpc: got %d", msgRes.StatusCode)
	}
	var ack map[string]any
	if err := json.NewDecoder(msgRes.Body).Decode(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["echo"] != "message" {
		t.Fatalf("unexpected ack: %v", ack)
	}

	// Controller sends close RPC; host receives command type "close".
	closeRes := doReq(t, "POST", srv.URL+"/v1/remote/sessions/s1/close", "ctrl-tok", nil)
	defer closeRes.Body.Close()
	if closeRes.StatusCode != http.StatusOK {
		t.Fatalf("controller close rpc: got %d", closeRes.StatusCode)
	}
	var closeAck map[string]any
	if err := json.NewDecoder(closeRes.Body).Decode(&closeAck); err != nil {
		t.Fatal(err)
	}
	if closeAck["echo"] != "close" {
		t.Fatalf("unexpected close ack: %v", closeAck)
	}
	<-pollDone

	// Unregister removes session and fails offline message requests immediately.
	delRes := doReq(t, "DELETE", srv.URL+"/v1/remote/host/sessions/s1?hostId=h1", "sync-tok", nil)
	delRes.Body.Close()
	offlineRes := doReq(t, "POST", srv.URL+"/v1/remote/sessions/s1/message", "ctrl-tok", map[string]any{"text": "late"})
	offlineRes.Body.Close()
	if offlineRes.StatusCode != http.StatusNotFound {
		t.Fatalf("offline message: got %d, want 404", offlineRes.StatusCode)
	}
}

func TestRemoteSweepExpiresIdleHost(t *testing.T) {
	relay, srv := newTestServer(t, "sync-tok", "ctrl-tok")
	now := time.Now()
	relay.now = func() time.Time { return now }
	relay.HostTTL = 30 * time.Second

	res := doReq(t, "POST", srv.URL+"/v1/remote/host/register", "sync-tok", map[string]any{
		"sessionId": "s-exp", "hostId": "h-exp", "device": "macbook", "cwd": "/Users/brain",
	})
	res.Body.Close()

	now = now.Add(31 * time.Second)
	relay.Sweep()

	listRes := doReq(t, "GET", srv.URL+"/v1/remote/sessions", "ctrl-tok", nil)
	defer listRes.Body.Close()
	var listed struct {
		Sessions []SessionMeta `json:"sessions"`
	}
	if err := json.NewDecoder(listRes.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Sessions) != 0 {
		t.Fatalf("expected expired host to be swept, got %+v", listed.Sessions)
	}
}
