package store

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/bry-guy/pi-sync/internal/session"
)

func usageEnvelope(id string) session.Envelope {
	return session.Envelope{FormatVersion: session.FormatVersion, SessionID: id, PiSessionVersion: 3, CreatedAt: "2026-01-01T00:00:00Z", HeadEntryID: "b",
		Workspace: &session.Workspace{GitRemote: "git@github.com:me/repo.git", Branch: "main", Commit: "0123456789abcdef0123456789abcdef01234567"},
		Entries: []json.RawMessage{
			json.RawMessage(`{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-02T10:00:00Z","message":{"role":"user","content":"hi"}}`),
			json.RawMessage(`{"type":"message","id":"b","parentId":"a","timestamp":"2026-01-02T10:00:01Z","message":{"role":"assistant","provider":"anthropic","model":"m","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1,"cost":{"total":0.5}}}}`),
		}}
}

func TestUsageCountedOnceAndKeptAfterDeletion(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.Create(usageEnvelope("u"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CountUsage("u", "laptop"); err != nil {
		t.Fatal(err)
	}
	if err := s.CountUsage("u", "laptop"); err != nil { // nothing new: no double count
		t.Fatal(err)
	}
	after, _ := s.Meta("u")
	if after.ETag != created.ETag || !after.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatal("counting usage changed the conversation's ETag or activity time")
	}
	appended, err := s.Append("u", created.ETag, 2, []json.RawMessage{json.RawMessage(`{"type":"message","id":"c","parentId":"b","timestamp":"2026-01-03T00:00:00Z","message":{"role":"assistant","provider":"anthropic","model":"m","usage":{"input":1,"output":1}}}`)}, session.Envelope{HeadEntryID: "c", Workspace: created.Envelope.Workspace})
	if err != nil {
		t.Fatal(err)
	}
	_ = appended
	if err := s.CountUsage("u", "web"); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.Usage("", "")
	if len(rows) != 2 || rows[0].Date != "2026-01-02" || rows[0].Input != 10 || rows[0].Cost != 0.5 || rows[0].Device != "laptop" || rows[0].Repository != "github.com/me/repo" || rows[1].Device != "web" || rows[1].Turns != 1 {
		t.Fatalf("rows = %+v", rows)
	}

	// Inactive and unleased: deleted, usage kept, id reserved.
	held := func(string) bool { return false }
	if deleted, err := s.Sweep(14*24*time.Hour, time.Now(), held); err != nil || len(deleted) != 0 {
		t.Fatalf("active conversation swept: %v %v", deleted, err)
	}
	if deleted, err := s.Sweep(14*24*time.Hour, time.Now().Add(15*24*time.Hour), func(string) bool { return true }); err != nil || len(deleted) != 0 {
		t.Fatalf("leased conversation swept: %v %v", deleted, err)
	}
	if deleted, err := s.Sweep(14*24*time.Hour, time.Now().Add(15*24*time.Hour), held); err != nil || len(deleted) != 1 {
		t.Fatalf("inactive conversation kept: %v %v", deleted, err)
	}
	if rows2, _ := s.Usage("", ""); len(rows2) != 2 {
		t.Fatalf("usage lost on deletion: %+v", rows2)
	}
	if list, _ := s.List(); len(list) != 0 {
		t.Fatalf("deleted conversation listed: %+v", list)
	}
	for name, call := range map[string]func() error{
		"meta":   func() error { _, err := s.Meta("u"); return err },
		"get":    func() error { _, err := s.Get("u"); return err },
		"append": func() error { _, err := s.Append("u", "x", 3, nil, session.Envelope{}); return err },
		"create": func() error { _, err := s.Create(usageEnvelope("u")); return err },
	} {
		if err := call(); !IsDeleted(err) {
			t.Fatalf("%s on a deleted conversation: %v", name, err)
		}
	}
	if _, err := os.Stat(s.Root() + "/sessions/u.log"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("entries were not removed")
	}
}

func TestBackfillCountsStoredConversations(t *testing.T) {
	s, _ := New(t.TempDir())
	if _, err := s.Create(usageEnvelope("v")); err != nil {
		t.Fatal(err)
	}
	if err := s.CountAllUsage(); err != nil {
		t.Fatal(err)
	}
	if err := s.CountAllUsage(); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.Usage("2026-01-01", "2026-01-02")
	if len(rows) != 1 || rows[0].Device != UnknownDevice || rows[0].Turns != 1 {
		t.Fatalf("rows = %+v", rows)
	}
}
