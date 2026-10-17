package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DeletedError reports a conversation whose entries were removed for inactivity. Its id stays reserved so an old
// local copy cannot upload the deleted history again.
type DeletedError struct {
	DeletedAt time.Time
}

func (e *DeletedError) Error() string { return "session was deleted" }

func IsDeleted(err error) bool {
	var deleted *DeletedError
	return errors.As(err, &deleted)
}

type tombstone struct {
	DeletedAt  time.Time `json:"deletedAt"`
	LastActive time.Time `json:"lastActive"`
	Title      string    `json:"title"`
}

// A dot-file, which List and older servers skip.
func tombstonePath(base string) string {
	return filepath.Join(filepath.Dir(base), "."+filepath.Base(base)+".deleted")
}

func deletedError(base string) error {
	data, err := readRegular(tombstonePath(base))
	if err != nil {
		return nil
	}
	var stone tombstone
	if json.Unmarshal(data, &stone) != nil {
		return &DeletedError{}
	}
	return &DeletedError{DeletedAt: stone.DeletedAt}
}

// LastActive is the latest write, read or lease by any device.
func LastActive(record Record) time.Time {
	last := record.UpdatedAt
	for _, device := range record.Devices {
		if device.LastSeen.After(last) {
			last = device.LastSeen
		}
	}
	return last
}

// Sweep deletes the entries of conversations inactive for longer than retention, after counting their usage.
// held reports conversations whose lease is active; they are never deleted.
func (s *Store) Sweep(retention time.Duration, now time.Time, held func(id string) bool) ([]string, error) {
	records, err := s.List()
	if err != nil {
		return nil, err
	}
	var deleted []string
	for _, record := range records {
		id := record.Envelope.SessionID
		if held(id) || now.Sub(LastActive(record)) <= retention {
			continue
		}
		if err := s.deleteInactive(id, retention, now, held); err != nil {
			return deleted, fmt.Errorf("delete %s: %w", id, err)
		}
		deleted = append(deleted, id)
	}
	return deleted, nil
}

func (s *Store) deleteInactive(id string, retention time.Duration, now time.Time, held func(string) bool) error {
	base, err := s.paths(id)
	if err != nil {
		return err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	m, err := s.load(base)
	if err != nil {
		return err
	}
	// Re-check under the lock: a write since List would have moved the activity time.
	record := s.record(m, base)
	if held(id) || now.Sub(LastActive(record)) <= retention {
		return nil
	}
	if err := s.countUsageLocked(base, ""); err != nil {
		return err
	}
	stone, err := json.Marshal(tombstone{DeletedAt: now.UTC(), LastActive: LastActive(record), Title: m.Title})
	if err != nil {
		return err
	}
	if err := writeAtomic(tombstonePath(base), stone); err != nil {
		return err
	}
	s.ids.drop(id)
	// meta first: without it the conversation reads as deleted even if removing the rest fails.
	for _, path := range []string{base + ".meta.json", base + ".json", base + ".log", base + ".idx", devicesPath(base)} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// CountAllUsage counts every conversation's uncounted entries; conversations stored before usage existed count as
// UnknownDevice.
func (s *Store) CountAllUsage() error {
	records, err := s.List()
	if err != nil {
		return err
	}
	for _, record := range records {
		if err := s.CountUsage(record.Envelope.SessionID, ""); err != nil {
			return err
		}
	}
	return nil
}
