package store

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bry-guy/pi-sync/internal/session"
)

var (
	ErrNotFound      = errors.New("session not found")
	ErrAlreadyExists = errors.New("session already exists")
)

type StaleETagError struct {
	Expected string
	Current  string
}

func (e *StaleETagError) Error() string {
	return fmt.Sprintf("stale session ETag: expected %q, current %q", e.Expected, e.Current)
}

type Record struct {
	Envelope session.Envelope
	ETag     string
	// UpdatedAt is the stored file's modification time; zero for records not read from disk.
	UpdatedAt time.Time
}

type Store struct {
	root  string
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func New(root string) (*Store, error) {
	if root == "" {
		return nil, fmt.Errorf("data directory is empty")
	}
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	return &Store{root: root, locks: make(map[string]*sync.Mutex)}, nil
}

func (s *Store) Root() string { return s.root }

func (s *Store) sessionPath(id string) (string, error) {
	if !session.SafeID(id) {
		return "", fmt.Errorf("invalid session id")
	}
	return filepath.Join(s.root, "sessions", id+".json"), nil
}

func (s *Store) lockFor(id string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if lock, ok := s.locks[id]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	s.locks[id] = lock
	return lock
}

func (s *Store) Create(envelope session.Envelope) (Record, error) {
	if err := session.Validate(envelope); err != nil {
		return Record{}, err
	}
	path, err := s.sessionPath(envelope.SessionID)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(envelope.SessionID)
	lock.Lock()
	defer lock.Unlock()

	if info, statErr := os.Lstat(path); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return Record{}, fmt.Errorf("session file is a symlink")
		}
		return Record{}, ErrAlreadyExists
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Record{}, fmt.Errorf("inspect session file: %w", statErr)
	}

	data, err := session.CanonicalBytes(envelope)
	if err != nil {
		return Record{}, err
	}
	if err := writeAtomic(path, data); err != nil {
		return Record{}, err
	}
	return Record{Envelope: envelope, ETag: etag(data)}, nil
}

func (s *Store) Get(id string) (Record, error) {
	path, err := s.sessionPath(id)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	return s.readPath(path)
}

func (s *Store) Update(id, expectedETag string, envelope session.Envelope) (Record, error) {
	if envelope.SessionID != id {
		return Record{}, fmt.Errorf("envelope session id does not match URL")
	}
	if err := session.Validate(envelope); err != nil {
		return Record{}, err
	}
	path, err := s.sessionPath(id)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()

	current, err := s.readPath(path)
	if err != nil {
		return Record{}, err
	}
	if expectedETag == "" || current.ETag != expectedETag {
		return Record{}, &StaleETagError{Expected: expectedETag, Current: current.ETag}
	}
	data, err := session.CanonicalBytes(envelope)
	if err != nil {
		return Record{}, err
	}
	if err := writeAtomic(path, data); err != nil {
		return Record{}, err
	}
	return Record{Envelope: envelope, ETag: etag(data)}, nil
}

func (s *Store) List() ([]Record, error) {
	directory := filepath.Join(s.root, "sessions")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || !session.SafeID(strings.TrimSuffix(name, ".json")) {
			return nil, fmt.Errorf("invalid file in sessions directory: %q", name)
		}
		info, err := entry.Info()
		if err != nil {
			return nil, fmt.Errorf("inspect session %q: %w", name, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("session file %q is a symlink", name)
		}
		record, err := s.readPathSummary(filepath.Join(directory, name))
		if err != nil {
			return nil, fmt.Errorf("read session %q: %w", name, err)
		}
		records = append(records, record)
	}
	return records, nil
}

func (s *Store) read(path string, summaryOnly bool) (Record, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, fmt.Errorf("inspect session: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return Record{}, fmt.Errorf("session file is a symlink")
	}
	if info.Size() > session.MaxEnvelopeBytes {
		return Record{}, fmt.Errorf("stored session is too large")
	}
	file, err := os.Open(path)
	if err != nil {
		return Record{}, fmt.Errorf("open session: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, session.MaxEnvelopeBytes+1))
	if err != nil {
		return Record{}, fmt.Errorf("read session: %w", err)
	}
	if len(data) > session.MaxEnvelopeBytes {
		return Record{}, fmt.Errorf("stored session is too large")
	}
	// Stored files were fully validated on write; reads only confirm the file is ours.
	var envelope session.Envelope
	if summaryOnly {
		// No entries field, so the decoder skips them without copying.
		var summary struct {
			FormatVersion    int                `json:"formatVersion"`
			SessionID        string             `json:"sessionId"`
			PiSessionVersion int                `json:"piSessionVersion"`
			CreatedAt        string             `json:"createdAt"`
			ParentSessionID  *string            `json:"parentSessionId"`
			HeadEntryID      string             `json:"headEntryId"`
			Title            string             `json:"title"`
			Workspace        *session.Workspace `json:"workspace,omitempty"`
		}
		err = json.Unmarshal(data, &summary)
		envelope = session.Envelope{FormatVersion: summary.FormatVersion, SessionID: summary.SessionID, PiSessionVersion: summary.PiSessionVersion, CreatedAt: summary.CreatedAt, ParentSessionID: summary.ParentSessionID, HeadEntryID: summary.HeadEntryID, Title: summary.Title, Workspace: summary.Workspace}
	} else {
		err = json.Unmarshal(data, &envelope)
	}
	if err != nil {
		return Record{}, fmt.Errorf("decode stored session: %w", err)
	}
	if envelope.FormatVersion != session.FormatVersion || envelope.SessionID+".json" != filepath.Base(path) {
		return Record{}, fmt.Errorf("stored session does not match its file")
	}
	return Record{Envelope: envelope, ETag: etag(data), UpdatedAt: info.ModTime().UTC()}, nil
}

func (s *Store) readPath(path string) (Record, error) { return s.read(path, false) }

// readPathSummary skips entries: listing needs only titles, heads and etags.
func (s *Store) readPathSummary(path string) (Record, error) { return s.read(path, true) }

func writeAtomic(path string, data []byte) error {
	directory := filepath.Dir(path)
	base := filepath.Base(path)
	file, err := os.CreateTemp(directory, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary session file: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return fmt.Errorf("restrict temporary session file: %w", err)
	}
	temporary := file.Name()
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()

	written, writeErr := file.Write(data)
	if writeErr == nil && written != len(data) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = file.Sync()
	}
	if closeErr := file.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		return fmt.Errorf("flush temporary session file: %w", writeErr)
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return fmt.Errorf("restrict temporary session file: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("replace session file: %w", err)
	}
	removeTemporary = false

	directoryFile, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open session directory: %w", err)
	}
	defer directoryFile.Close()
	if err := directoryFile.Sync(); err != nil {
		return fmt.Errorf("flush session directory: %w", err)
	}
	return nil
}

func etag(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("\"sha256-%x\"", sum[:])
}

func IsStaleETag(err error) bool {
	var stale *StaleETagError
	return errors.As(err, &stale)
}

// Ready reports whether the sessions directory is readable without reading any session.
func (s *Store) Ready() error {
	_, err := os.ReadDir(filepath.Join(s.root, "sessions"))
	return err
}
