package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/bry-guy/pi-sync/internal/session"
)

// Usage is kept forever, even after a conversation's entries are deleted: one row per day, provider, model, device and
// repository, summed from assistant messages' token usage.
type UsageRow struct {
	Date       string  `json:"date"`
	Provider   string  `json:"provider"`
	Model      string  `json:"model"`
	Device     string  `json:"device"`
	Repository string  `json:"repository"`
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cacheRead"`
	CacheWrite int64   `json:"cacheWrite"`
	Cost       float64 `json:"cost"`
	Turns      int64   `json:"turns"`
}

func (r UsageRow) key() string {
	return r.Date + "\x00" + r.Provider + "\x00" + r.Model + "\x00" + r.Device + "\x00" + r.Repository
}

// UnknownDevice attributes usage counted without a writer, such as conversations stored before usage was recorded.
const UnknownDevice = "unknown"

func (s *Store) usagePath() string { return filepath.Join(s.root, "usage.json") }

// Usage returns the rows whose date is within [from, to] (YYYY-MM-DD; empty means unbounded), oldest first.
func (s *Store) Usage(from, to string) ([]UsageRow, error) {
	s.usageMu.Lock()
	defer s.usageMu.Unlock()
	rows, err := s.readUsage()
	if err != nil {
		return nil, err
	}
	out := make([]UsageRow, 0, len(rows))
	for _, row := range rows {
		if (from == "" || row.Date >= from) && (to == "" || row.Date <= to) {
			out = append(out, row)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return out, nil
}

func (s *Store) readUsage() (map[string]UsageRow, error) {
	rows := map[string]UsageRow{}
	data, err := readRegular(s.usagePath())
	if os.IsNotExist(err) {
		return rows, nil
	}
	if err != nil {
		return nil, err
	}
	var list []UsageRow
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("decode usage: %w", err)
	}
	for _, row := range list {
		rows[row.key()] = row
	}
	return rows, nil
}

func (s *Store) addUsage(rows []UsageRow) error {
	if len(rows) == 0 {
		return nil
	}
	s.usageMu.Lock()
	defer s.usageMu.Unlock()
	current, err := s.readUsage()
	if err != nil {
		return err
	}
	for _, row := range rows {
		total := current[row.key()]
		if total.Date == "" {
			total = UsageRow{Date: row.Date, Provider: row.Provider, Model: row.Model, Device: row.Device, Repository: row.Repository}
		}
		total.Input += row.Input
		total.Output += row.Output
		total.CacheRead += row.CacheRead
		total.CacheWrite += row.CacheWrite
		total.Cost += row.Cost
		total.Turns += row.Turns
		current[row.key()] = total
	}
	list := make([]UsageRow, 0, len(current))
	for _, row := range current {
		list = append(list, row)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].key() < list[j].key() })
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return writeAtomic(s.usagePath(), data)
}

type usageEntry struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Role     string `json:"role"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Usage    *struct {
			Input      int64 `json:"input"`
			Output     int64 `json:"output"`
			CacheRead  int64 `json:"cacheRead"`
			CacheWrite int64 `json:"cacheWrite"`
			Cost       struct {
				Total float64 `json:"total"`
			} `json:"cost"`
		} `json:"usage"`
	} `json:"message"`
}

func usageRows(entries []json.RawMessage, device, repository string, now time.Time) []UsageRow {
	rows := map[string]UsageRow{}
	for _, raw := range entries {
		var entry usageEntry
		if json.Unmarshal(raw, &entry) != nil || entry.Type != "message" || entry.Message.Role != "assistant" || entry.Message.Usage == nil {
			continue
		}
		date := now.UTC().Format(time.DateOnly)
		if at, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			date = at.UTC().Format(time.DateOnly)
		}
		usage := entry.Message.Usage
		row := UsageRow{Date: date, Provider: entry.Message.Provider, Model: entry.Message.Model, Device: device, Repository: repository}
		total := rows[row.key()]
		if total.Date == "" {
			total = row
		}
		total.Input += usage.Input
		total.Output += usage.Output
		total.CacheRead += usage.CacheRead
		total.CacheWrite += usage.CacheWrite
		total.Cost += usage.Cost.Total
		total.Turns++
		rows[row.key()] = total
	}
	out := make([]UsageRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

// CountUsage adds the usage of entries not yet counted to the ledger, attributed to device.
func (s *Store) CountUsage(id, device string) error {
	base, err := s.paths(id)
	if err != nil {
		return err
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	return s.countUsageLocked(base, device)
}

func (s *Store) countUsageLocked(base, device string) error {
	m, err := s.load(base)
	if err != nil {
		return err
	}
	if m.UsageCounted >= m.Count {
		return nil
	}
	start, err := offsetBefore(base, m.UsageCounted)
	if err != nil {
		return err
	}
	entries, err := readEntries(base+".log", start, m.Bytes)
	if err != nil {
		return err
	}
	if device == "" {
		device = UnknownDevice
	}
	repository := ""
	if m.Workspace != nil {
		repository = session.NormalizeGitRemote(m.Workspace.GitRemote)
	}
	// shortcut: the ledger is written before meta, so a crash between them counts those entries twice; rare and small.
	if err := s.addUsage(usageRows(entries, device, repository, time.Now())); err != nil {
		return err
	}
	m.UsageCounted = m.Count
	return writeMetaKeepTime(base, m)
}

// writeMetaKeepTime records bookkeeping without moving the conversation's updatedAt, which measures activity.
func writeMetaKeepTime(base string, m meta) error {
	info, statErr := os.Stat(base + ".meta.json")
	if err := writeMeta(base, m); err != nil {
		return err
	}
	if statErr == nil {
		return os.Chtimes(base+".meta.json", info.ModTime(), info.ModTime())
	}
	return nil
}
