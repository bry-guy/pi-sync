package session

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
)

func chain(n int) Envelope {
	e := Envelope{FormatVersion: FormatVersion, SessionID: "s", PiSessionVersion: 3, CreatedAt: "2026-01-01T00:00:00Z", Title: "t"}
	parent := "null"
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("e%07d", i)
		e.Entries = append(e.Entries, json.RawMessage(fmt.Sprintf(`{"type":"message","id":%q,"parentId":%s,"timestamp":"2026-01-01T00:00:00Z"}`, id, parent)))
		parent = fmt.Sprintf("%q", id)
		e.HeadEntryID = id
	}
	return e
}

// Long conversations once cost quadratic memory here and crashed the server.
func TestValidateLongChainIsLinear(t *testing.T) {
	e := chain(20000)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if err := Validate(e); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if used := after.TotalAlloc - before.TotalAlloc; used > 64<<20 {
		t.Fatalf("validating 20000 entries allocated %d MB", used>>20)
	}
}

func TestValidateRejectsCycleBesideRoot(t *testing.T) {
	e := chain(2)
	e.Entries = append(e.Entries,
		json.RawMessage(`{"type":"message","id":"x","parentId":"y","timestamp":"2026-01-01T00:00:00Z"}`),
		json.RawMessage(`{"type":"message","id":"y","parentId":"x","timestamp":"2026-01-01T00:00:00Z"}`))
	err := Validate(e)
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("want cycle error, got %v", err)
	}
}
