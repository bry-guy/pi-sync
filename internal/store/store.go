package store

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
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

// A conversation is stored as three files so a turn costs O(what it added), not O(conversation):
//
//	<id>.log        one entry per line, append-only
//	<id>.idx        8-byte end offset of each entry in the log, for paging
//	<id>.meta.json  header fields, entry count, log length and ETag (written last; it is the commit point)
//
// A crash between the log append and the meta write leaves bytes past meta.Bytes, which reads ignore and the
// next write truncates. Conversations stored by older servers as <id>.json are converted on first use and the
// old file is left in place, so a rollback loses only turns written after the upgrade.

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
	// Envelope.Entries holds only the entries a call asked for (none for metadata reads).
	Envelope session.Envelope
	ETag     string
	// Count is the total number of entries in the conversation.
	Count     int
	UpdatedAt time.Time
}

type meta struct {
	FormatVersion    int                `json:"formatVersion"`
	SessionID        string             `json:"sessionId"`
	PiSessionVersion int                `json:"piSessionVersion"`
	CreatedAt        string             `json:"createdAt"`
	ParentSessionID  *string            `json:"parentSessionId"`
	HeadEntryID      string             `json:"headEntryId"`
	Title            string             `json:"title"`
	Workspace        *session.Workspace `json:"workspace,omitempty"`
	Count            int                `json:"count"`
	Bytes            int64              `json:"bytes"`
	// Chain hashes the entries in order: chain_n = sha256(chain_{n-1} || entry_n).
	Chain string `json:"chain"`
	ETag  string `json:"etag"`
	// LegacyETag is the whole-file ETag an older server reported; clients holding it stay current until the next write.
	LegacyETag string `json:"legacyEtag,omitempty"`
}

func (m meta) envelope() session.Envelope {
	return session.Envelope{FormatVersion: m.FormatVersion, SessionID: m.SessionID, PiSessionVersion: m.PiSessionVersion, CreatedAt: m.CreatedAt, ParentSessionID: m.ParentSessionID, HeadEntryID: m.HeadEntryID, Title: m.Title, Workspace: m.Workspace, Entries: []json.RawMessage{}}
}

// currentETag is what clients see: the legacy ETag until the first write after conversion.
func (m meta) currentETag() string {
	if m.LegacyETag != "" {
		return m.LegacyETag
	}
	return m.ETag
}

func (m meta) matches(etag string) bool {
	return etag != "" && (etag == m.ETag || etag == m.LegacyETag)
}

type Store struct {
	root  string
	mu    sync.Mutex
	locks map[string]*sync.Mutex
	ids   *idCache
}

func New(root string) (*Store, error) {
	if root == "" {
		return nil, fmt.Errorf("data directory is empty")
	}
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	return &Store{root: root, locks: make(map[string]*sync.Mutex), ids: newIDCache(16)}, nil
}

func (s *Store) Root() string { return s.root }

func (s *Store) paths(id string) (base string, err error) {
	if !session.SafeID(id) {
		return "", fmt.Errorf("invalid session id")
	}
	return filepath.Join(s.root, "sessions", id), nil
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
	base, err := s.paths(envelope.SessionID)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(envelope.SessionID)
	lock.Lock()
	defer lock.Unlock()
	for _, path := range []string{base + ".meta.json", base + ".json"} {
		if info, statErr := os.Lstat(path); statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return Record{}, fmt.Errorf("session file is a symlink")
			}
			return Record{}, ErrAlreadyExists
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return Record{}, fmt.Errorf("inspect session file: %w", statErr)
		}
	}
	m, err := s.rewrite(base, envelope, "")
	if err != nil {
		return Record{}, err
	}
	return withEntries(s.record(m, base), envelope), nil
}

// withEntries answers a whole-conversation write with the whole conversation, as older clients expect.
func withEntries(record Record, envelope session.Envelope) Record {
	record.Envelope.Entries = envelope.Entries
	return record
}

// Meta reads the conversation's header, count and ETag without touching its entries.
func (s *Store) Meta(id string) (Record, error) {
	base, err := s.paths(id)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	m, err := s.load(base)
	if err != nil {
		return Record{}, err
	}
	return s.record(m, base), nil
}

// Get reads the whole conversation; only older clients need it.
func (s *Store) Get(id string) (Record, error) {
	record, _, err := s.Entries(id, 0, -1)
	return record, err
}

// Entries returns entries from index `from` on, stopping before maxBytes of entries (at least one entry; -1 for no
// limit). complete reports whether the page reached the end.
func (s *Store) Entries(id string, from int, maxBytes int64) (Record, bool, error) {
	base, err := s.paths(id)
	if err != nil {
		return Record{}, false, err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	m, err := s.load(base)
	if err != nil {
		return Record{}, false, err
	}
	record := s.record(m, base)
	if from < 0 || from > m.Count {
		return Record{}, false, &RangeError{Count: m.Count}
	}
	start, err := offsetBefore(base, from)
	if err != nil {
		return Record{}, false, err
	}
	end := m.Bytes
	if maxBytes >= 0 && end-start > maxBytes {
		if end, err = pageEnd(base, from, m.Count, start, maxBytes); err != nil {
			return Record{}, false, err
		}
	}
	entries, err := readEntries(base+".log", start, end)
	if err != nil {
		return Record{}, false, err
	}
	record.Envelope.Entries = entries
	return record, from+len(entries) == m.Count, nil
}

// RangeError reports a `from` beyond the conversation; the client's copy is not a prefix of the server's.
type RangeError struct{ Count int }

func (e *RangeError) Error() string { return fmt.Sprintf("entry range is outside 0..%d", e.Count) }

// Append adds entries to the end of the conversation. baseCount must equal the stored count, so a client can only
// append to the copy it last saw, and the ETag must match as with Update.
func (s *Store) Append(id, expectedETag string, baseCount int, entries []json.RawMessage, header session.Envelope) (Record, error) {
	base, err := s.paths(id)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	m, err := s.load(base)
	if err != nil {
		return Record{}, err
	}
	if !m.matches(expectedETag) || baseCount != m.Count {
		return Record{}, &StaleETagError{Expected: expectedETag, Current: m.currentETag()}
	}
	ids, err := s.ids.get(id, func() (map[string]struct{}, error) { return readIDs(base+".log", m.Bytes) })
	if err != nil {
		return Record{}, err
	}
	exists := func(entryID string) bool { _, ok := ids[entryID]; return ok }
	parsed, err := session.ValidateAppend(entries, exists, m.Count == 0)
	if err != nil {
		return Record{}, err
	}
	head := header.HeadEntryID
	if head == "" {
		head = m.HeadEntryID
	}
	if _, ok := ids[head]; !ok && !containsID(parsed, head) {
		return Record{}, &session.ValidationError{Field: "headEntryId", Message: "does not belong to entries"}
	}
	next := m
	next.HeadEntryID, next.Title, next.Workspace = head, header.Title, header.Workspace
	if err := session.ValidateHeader(next.envelope()); err != nil {
		return Record{}, err
	}
	if next, err = appendEntries(base, next, entries); err != nil {
		s.ids.drop(id)
		return Record{}, err
	}
	for _, entry := range parsed {
		ids[entry.ID] = struct{}{}
	}
	return s.record(next, base), nil
}

// Update replaces the whole conversation; older clients use it. Newer clients append.
func (s *Store) Update(id, expectedETag string, envelope session.Envelope) (Record, error) {
	if envelope.SessionID != id {
		return Record{}, fmt.Errorf("envelope session id does not match URL")
	}
	if err := session.Validate(envelope); err != nil {
		return Record{}, err
	}
	base, err := s.paths(id)
	if err != nil {
		return Record{}, err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	current, err := s.load(base)
	if err != nil {
		return Record{}, err
	}
	if !current.matches(expectedETag) {
		return Record{}, &StaleETagError{Expected: expectedETag, Current: current.currentETag()}
	}
	s.ids.drop(id)
	m, err := s.rewrite(base, envelope, "")
	if err != nil {
		return Record{}, err
	}
	return withEntries(s.record(m, base), envelope), nil
}

func (s *Store) List() ([]Record, error) {
	directory := filepath.Join(s.root, "sessions")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	seen := map[string]bool{}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		var id string
		switch {
		case strings.HasSuffix(name, ".meta.json"):
			id = strings.TrimSuffix(name, ".meta.json")
		case strings.HasSuffix(name, ".json"):
			id = strings.TrimSuffix(name, ".json")
		case strings.HasSuffix(name, ".log"), strings.HasSuffix(name, ".idx"), strings.HasPrefix(name, "."):
			continue
		default:
			return nil, fmt.Errorf("invalid file in sessions directory: %q", name)
		}
		if entry.IsDir() || !session.SafeID(id) {
			return nil, fmt.Errorf("invalid file in sessions directory: %q", name)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		record, err := s.Meta(id)
		if err != nil {
			return nil, fmt.Errorf("read session %q: %w", id, err)
		}
		records = append(records, record)
	}
	return records, nil
}

func (s *Store) record(m meta, base string) Record {
	record := Record{Envelope: m.envelope(), ETag: m.currentETag(), Count: m.Count}
	if info, err := os.Stat(base + ".meta.json"); err == nil {
		record.UpdatedAt = info.ModTime().UTC()
	}
	return record
}

// load reads meta, converting an older whole-file conversation on first use.
func (s *Store) load(base string) (meta, error) {
	data, err := readRegular(base + ".meta.json")
	if errors.Is(err, os.ErrNotExist) {
		return s.convert(base)
	}
	if err != nil {
		return meta{}, err
	}
	var m meta
	if err := json.Unmarshal(data, &m); err != nil {
		return meta{}, fmt.Errorf("decode session metadata: %w", err)
	}
	if m.FormatVersion != session.FormatVersion || m.SessionID != filepath.Base(base) {
		return meta{}, fmt.Errorf("stored session does not match its file")
	}
	return m, nil
}

func (s *Store) convert(base string) (meta, error) {
	data, err := readRegular(base + ".json")
	if errors.Is(err, os.ErrNotExist) {
		return meta{}, ErrNotFound
	}
	if err != nil {
		return meta{}, err
	}
	var envelope session.Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return meta{}, fmt.Errorf("decode stored session: %w", err)
	}
	if envelope.FormatVersion != session.FormatVersion || envelope.SessionID != filepath.Base(base) {
		return meta{}, fmt.Errorf("stored session does not match its file")
	}
	sum := sha256.Sum256(data)
	return s.rewrite(base, envelope, fmt.Sprintf("\"sha256-%x\"", sum[:]))
}

// rewrite replaces all three files with the given conversation.
func (s *Store) rewrite(base string, envelope session.Envelope, legacyETag string) (meta, error) {
	m := meta{FormatVersion: session.FormatVersion, SessionID: envelope.SessionID, PiSessionVersion: envelope.PiSessionVersion, CreatedAt: envelope.CreatedAt, ParentSessionID: envelope.ParentSessionID, HeadEntryID: envelope.HeadEntryID, Title: envelope.Title, Workspace: envelope.Workspace, LegacyETag: legacyETag}
	var log, idx bytes.Buffer
	chain := sha256.Sum256(nil)
	for _, raw := range envelope.Entries {
		line, err := compactLine(raw)
		if err != nil {
			return meta{}, err
		}
		log.Write(line)
		idx.Write(binary.BigEndian.AppendUint64(nil, uint64(log.Len())))
		chain = sha256.Sum256(append(chain[:], line...))
	}
	m.Count, m.Bytes, m.Chain = len(envelope.Entries), int64(log.Len()), hex.EncodeToString(chain[:])
	m.ETag = etagFor(m)
	if err := writeAtomic(base+".log", log.Bytes()); err != nil {
		return meta{}, err
	}
	if err := writeAtomic(base+".idx", idx.Bytes()); err != nil {
		return meta{}, err
	}
	return m, writeMeta(base, m)
}

func appendEntries(base string, m meta, entries []json.RawMessage) (meta, error) {
	log, err := openAppend(base+".log", m.Bytes)
	if err != nil {
		return meta{}, err
	}
	defer log.Close()
	idx, err := openAppend(base+".idx", int64(m.Count)*8)
	if err != nil {
		return meta{}, err
	}
	defer idx.Close()
	chain, err := hex.DecodeString(m.Chain)
	if err != nil {
		return meta{}, fmt.Errorf("decode session chain: %w", err)
	}
	var lines, offsets bytes.Buffer
	for _, raw := range entries {
		line, err := compactLine(raw)
		if err != nil {
			return meta{}, err
		}
		lines.Write(line)
		offsets.Write(binary.BigEndian.AppendUint64(nil, uint64(m.Bytes)+uint64(lines.Len())))
		sum := sha256.Sum256(append(chain, line...))
		chain = sum[:]
	}
	if _, err := log.Write(lines.Bytes()); err != nil {
		return meta{}, fmt.Errorf("append session log: %w", err)
	}
	if _, err := idx.Write(offsets.Bytes()); err != nil {
		return meta{}, fmt.Errorf("append session index: %w", err)
	}
	if err := log.Sync(); err != nil {
		return meta{}, fmt.Errorf("flush session log: %w", err)
	}
	if err := idx.Sync(); err != nil {
		return meta{}, fmt.Errorf("flush session index: %w", err)
	}
	m.Count += len(entries)
	m.Bytes += int64(lines.Len())
	m.Chain = hex.EncodeToString(chain)
	m.LegacyETag = ""
	m.ETag = etagFor(m)
	return m, writeMeta(base, m)
}

// openAppend opens a file for appending at `size`, dropping anything a crashed write left past it.
func openAppend(path string, size int64) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	if err := file.Truncate(size); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("truncate %s: %w", filepath.Base(path), err)
	}
	if _, err := file.Seek(size, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("seek %s: %w", filepath.Base(path), err)
	}
	return file, nil
}

// etagFor covers the entries (through the chain) and every header field, so a head or title change is a new version.
func etagFor(m meta) string {
	m.ETag, m.LegacyETag = "", ""
	header, _ := json.Marshal(m)
	sum := sha256.Sum256(header)
	return fmt.Sprintf("\"sha256-%x\"", sum[:])
}

func writeMeta(base string, m meta) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeAtomic(base+".meta.json", data)
}

func compactLine(raw json.RawMessage) ([]byte, error) {
	var line bytes.Buffer
	if err := json.Compact(&line, raw); err != nil {
		return nil, fmt.Errorf("compact entry: %w", err)
	}
	line.WriteByte('\n')
	return line.Bytes(), nil
}

func offsetBefore(base string, index int) (int64, error) {
	if index == 0 {
		return 0, nil
	}
	return readOffset(base, index-1)
}

func readOffset(base string, index int) (int64, error) {
	file, err := os.Open(base + ".idx")
	if err != nil {
		return 0, fmt.Errorf("open session index: %w", err)
	}
	defer file.Close()
	var buffer [8]byte
	if _, err := file.ReadAt(buffer[:], int64(index)*8); err != nil {
		return 0, fmt.Errorf("read session index: %w", err)
	}
	return int64(binary.BigEndian.Uint64(buffer[:])), nil
}

// pageEnd finds the end of the last whole entry within maxBytes of start (always at least one entry).
func pageEnd(base string, from, count int, start, maxBytes int64) (int64, error) {
	low, high := from, count-1 // entry indexes; find the largest whose end offset fits
	end, err := readOffset(base, from)
	if err != nil {
		return 0, err
	}
	for low < high {
		mid := (low + high + 1) / 2
		offset, err := readOffset(base, mid)
		if err != nil {
			return 0, err
		}
		if offset-start <= maxBytes {
			low, end = mid, offset
		} else {
			high = mid - 1
		}
	}
	return end, nil
}

func readEntries(path string, start, end int64) ([]json.RawMessage, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open session log: %w", err)
	}
	defer file.Close()
	data := make([]byte, end-start)
	if _, err := file.ReadAt(data, start); err != nil && !(errors.Is(err, io.EOF) && len(data) == 0) {
		return nil, fmt.Errorf("read session log: %w", err)
	}
	entries := []json.RawMessage{}
	for len(data) > 0 {
		line, rest, _ := bytes.Cut(data, []byte{'\n'})
		entries = append(entries, json.RawMessage(line))
		data = rest
	}
	return entries, nil
}

func readIDs(path string, size int64) (map[string]struct{}, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open session log: %w", err)
	}
	defer file.Close()
	ids := map[string]struct{}{}
	scanner := bufio.NewScanner(io.LimitReader(file, size))
	scanner.Buffer(make([]byte, 0, 1<<20), session.MaxEntryBytes+1)
	for scanner.Scan() {
		var entry struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return nil, fmt.Errorf("decode stored entry: %w", err)
		}
		ids[entry.ID] = struct{}{}
	}
	return ids, scanner.Err()
}

func containsID(entries []session.Entry, id string) bool {
	for _, entry := range entries {
		if entry.ID == id {
			return true
		}
	}
	return false
}

func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("session file is a symlink")
	}
	return os.ReadFile(path)
}

// idCache keeps entry ids for recently written conversations so an append checks duplicates and parents without
// rereading the log. Bounded so memory stays flat however many conversations exist.
type idCache struct {
	mu    sync.Mutex
	limit int
	order []string
	sets  map[string]map[string]struct{}
}

func newIDCache(limit int) *idCache {
	return &idCache{limit: limit, sets: map[string]map[string]struct{}{}}
}

func (c *idCache) get(id string, load func() (map[string]struct{}, error)) (map[string]struct{}, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if set, ok := c.sets[id]; ok {
		return set, nil
	}
	set, err := load()
	if err != nil {
		return nil, err
	}
	if len(c.order) >= c.limit {
		delete(c.sets, c.order[0])
		c.order = c.order[1:]
	}
	c.sets[id], c.order = set, append(c.order, id)
	return set, nil
}

func (c *idCache) drop(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.sets, id)
	for i, existing := range c.order {
		if existing == id {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

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

func IsStaleETag(err error) bool {
	var stale *StaleETagError
	return errors.As(err, &stale)
}

// Ready reports whether the sessions directory is readable without reading any session.
func (s *Store) Ready() error {
	_, err := os.ReadDir(filepath.Join(s.root, "sessions"))
	return err
}
