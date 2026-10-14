package store

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bry-guy/pi-sync/internal/session"
)

func entry(id, parent string) json.RawMessage {
	p := "null"
	if parent != "" {
		p = fmt.Sprintf("%q", parent)
	}
	return json.RawMessage(fmt.Sprintf(`{"type":"message","id":%q,"parentId":%s,"timestamp":"2026-01-01T00:00:00Z","pad":%q}`, id, p, strings.Repeat("x", 100)))
}

func TestAppendIsCompareAndSwapOnEtagAndCount(t *testing.T) {
	s, _ := New(t.TempDir())
	created, err := s.Create(storeEnvelope("c"))
	if err != nil {
		t.Fatal(err)
	}
	next, err := s.Append("c", created.ETag, 1, []json.RawMessage{entry("b", "a")}, session.Envelope{HeadEntryID: "b", Title: "t"})
	if err != nil || next.Count != 2 || next.ETag == created.ETag {
		t.Fatalf("append: %+v %v", next, err)
	}
	if _, err := s.Append("c", created.ETag, 2, []json.RawMessage{entry("c", "b")}, session.Envelope{HeadEntryID: "c"}); !IsStaleETag(err) {
		t.Fatalf("old etag accepted: %v", err)
	}
	if _, err := s.Append("c", next.ETag, 1, []json.RawMessage{entry("c", "b")}, session.Envelope{HeadEntryID: "c"}); !IsStaleETag(err) {
		t.Fatalf("wrong base count accepted: %v", err)
	}
	if _, err := s.Append("c", next.ETag, 2, []json.RawMessage{entry("b", "a")}, session.Envelope{HeadEntryID: "b"}); err == nil {
		t.Fatal("duplicate id accepted")
	}
	if _, err := s.Append("c", next.ETag, 2, []json.RawMessage{entry("d", "missing")}, session.Envelope{HeadEntryID: "d"}); err == nil {
		t.Fatal("missing parent accepted")
	}
	full, err := s.Get("c")
	if err != nil || len(full.Envelope.Entries) != 2 || full.Envelope.HeadEntryID != "b" || full.ETag != next.ETag {
		t.Fatalf("get after append: %+v %v", full, err)
	}
	if err := session.Validate(full.Envelope); err != nil {
		t.Fatal(err)
	}
	// Moving only the head is a new version.
	moved, err := s.Append("c", next.ETag, 2, nil, session.Envelope{HeadEntryID: "a", Title: "t"})
	if err != nil || moved.ETag == next.ETag {
		t.Fatalf("head move: %v", err)
	}
}

func TestOlderWholeFileConversationIsConvertedAndItsEtagStillWorks(t *testing.T) {
	root := t.TempDir()
	s, _ := New(root)
	data, _ := json.Marshal(storeEnvelope("old"))
	path := filepath.Join(root, "sessions", "old.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	legacy := fmt.Sprintf("\"sha256-%x\"", sum[:])
	got, err := s.Meta("old")
	if err != nil || got.ETag != legacy || got.Count != 1 {
		t.Fatalf("converted: %+v %v", got, err)
	}
	list, err := s.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list lists the conversation once: %d %v", len(list), err)
	}
	next, err := s.Append("old", legacy, 1, []json.RawMessage{entry("b", "a")}, session.Envelope{HeadEntryID: "b", Title: "title"})
	if err != nil || next.ETag == legacy {
		t.Fatalf("append with the etag clients already hold: %v", err)
	}
	if _, err := s.Append("old", legacy, 2, []json.RawMessage{entry("c", "b")}, session.Envelope{HeadEntryID: "c"}); !IsStaleETag(err) {
		t.Fatal("legacy etag must stop working after the first write")
	}
	if kept, _ := os.ReadFile(path); string(kept) != string(data) {
		t.Fatal("the old file is left untouched for rollback")
	}
}

func TestPagingAndCrashLeftovers(t *testing.T) {
	root := t.TempDir()
	s, _ := New(root)
	created, _ := s.Create(storeEnvelope("p"))
	etag, parent := created.ETag, "a"
	for i := 0; i < 50; i++ {
		id := fmt.Sprintf("e%02d", i)
		r, err := s.Append("p", etag, 1+i, []json.RawMessage{entry(id, parent)}, session.Envelope{HeadEntryID: id})
		if err != nil {
			t.Fatal(err)
		}
		etag, parent = r.ETag, id
	}
	var all []json.RawMessage
	for from := 0; ; {
		page, complete, err := s.Entries("p", from, 1000)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Envelope.Entries) == 0 {
			t.Fatal("a page always makes progress")
		}
		all = append(all, page.Envelope.Entries...)
		from += len(page.Envelope.Entries)
		if complete {
			break
		}
	}
	if len(all) != 51 {
		t.Fatalf("paged %d entries", len(all))
	}
	if _, _, err := s.Entries("p", 52, -1); err == nil {
		t.Fatal("from past the end must fail")
	}
	// A crash after the log append but before metadata leaves garbage past the committed length.
	log, _ := os.OpenFile(filepath.Join(root, "sessions", "p.log"), os.O_APPEND|os.O_WRONLY, 0o600)
	log.WriteString(`{"type":"message","id":"ghost"`)
	log.Close()
	if r, _ := s.Get("p"); len(r.Envelope.Entries) != 51 {
		t.Fatal("uncommitted bytes are not read")
	}
	if _, err := s.Append("p", etag, 51, []json.RawMessage{entry("z", parent)}, session.Envelope{HeadEntryID: "z"}); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Get("p"); len(r.Envelope.Entries) != 52 || session.Validate(r.Envelope) != nil {
		t.Fatal("the next append replaces the uncommitted bytes")
	}
}

// A turn must cost the same however long the conversation is.
func TestAppendTimeIsFlatAsTheConversationGrows(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	s, _ := New(t.TempDir())
	created, _ := s.Create(storeEnvelope("big"))
	etag, parent, count := created.ETag, "a", 1
	batch := func(n int) time.Duration {
		started := time.Now()
		for i := 0; i < n; i++ {
			id := fmt.Sprintf("e%07d", count)
			r, err := s.Append("big", etag, count, []json.RawMessage{entry(id, parent)}, session.Envelope{HeadEntryID: id})
			if err != nil {
				t.Fatal(err)
			}
			etag, parent, count = r.ETag, id, count+1
		}
		return time.Since(started) / time.Duration(n)
	}
	early := batch(200)
	// Grow the log to ~100 MB in large appends, then measure single-entry turns again.
	big := strings.Repeat("y", 1<<20)
	for i := 0; i < 100; i++ {
		id := fmt.Sprintf("big%04d", i)
		raw := json.RawMessage(fmt.Sprintf(`{"type":"message","id":%q,"parentId":%q,"timestamp":"2026-01-01T00:00:00Z","pad":%q}`, id, parent, big))
		r, err := s.Append("big", etag, count, []json.RawMessage{raw}, session.Envelope{HeadEntryID: id})
		if err != nil {
			t.Fatal(err)
		}
		etag, parent, count = r.ETag, id, count+1
	}
	late := batch(200)
	t.Logf("append per turn: %v at start, %v at ~100 MB", early, late)
	if late > early*5+2*time.Millisecond {
		t.Fatalf("append slowed from %v to %v as the conversation grew", early, late)
	}
}

func TestDevicesNeverChangeETagOrUpdatedAt(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.Create(session.Envelope{FormatVersion: session.FormatVersion, SessionID: "d", PiSessionVersion: 3, CreatedAt: "2026-01-01T00:00:00Z", HeadEntryID: "a", Entries: []json.RawMessage{json.RawMessage(`{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:01Z"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s.NoteDevice("d", "laptop", now)
	s.NoteDevice("d", "web", now.Add(time.Second))
	s.NoteDevice("d", "laptop", now.Add(2*time.Second)) // within the refresh window: no rewrite
	s.NoteDevice("missing", "laptop", now)
	record, err := s.Meta("d")
	if err != nil {
		t.Fatal(err)
	}
	if record.ETag != created.ETag || !record.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("recording devices changed the conversation: %v %v", record.ETag, record.UpdatedAt)
	}
	if len(record.Devices) != 2 || record.Devices[0].Label != "web" || record.Devices[1].Label != "laptop" {
		t.Fatalf("devices = %+v", record.Devices)
	}
	if list, err := s.List(); err != nil || len(list) != 1 {
		t.Fatalf("list = %v %v", list, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sessions", ".missing.devices")); err == nil {
		t.Fatal("recorded a device for a conversation that does not exist")
	}
}
