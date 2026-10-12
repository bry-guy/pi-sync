package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/bry-guy/pi-sync/internal/session"
)

func storeEnvelope(id string) session.Envelope {
	return session.Envelope{
		FormatVersion:    session.FormatVersion,
		SessionID:        id,
		PiSessionVersion: 3,
		CreatedAt:        "2026-01-01T00:00:00Z",
		HeadEntryID:      "a",
		Title:            "title",
		Entries: []json.RawMessage{
			json.RawMessage(`{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:01Z"}`),
		},
	}
}

func TestCreateUpdateAndList(t *testing.T) {
	root := t.TempDir()
	filesystem, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	created, err := filesystem.Create(storeEnvelope("session-1"))
	if err != nil {
		t.Fatal(err)
	}
	if created.ETag == "" {
		t.Fatal("create did not return stored bytes and ETag")
	}
	if _, err := filesystem.Create(storeEnvelope("session-1")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate create error = %v", err)
	}
	updatedEnvelope := storeEnvelope("session-1")
	updatedEnvelope.Title = "updated"
	updated, err := filesystem.Update("session-1", created.ETag, updatedEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ETag == created.ETag {
		t.Fatal("update did not change ETag")
	}
	if _, err := filesystem.Update("session-1", created.ETag, updatedEnvelope); !IsStaleETag(err) {
		t.Fatalf("stale update error = %v", err)
	}
	records, err := filesystem.List()
	if err != nil || len(records) != 1 {
		t.Fatalf("List() records=%d error=%v", len(records), err)
	}
}

func TestStoreRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	filesystem, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "outside.json")
	if err := os.WriteFile(target, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "sessions", "session-1.json")
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := filesystem.Create(storeEnvelope("session-1")); err == nil {
		t.Fatal("symlink was accepted")
	}
}
