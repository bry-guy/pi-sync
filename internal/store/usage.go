package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

// Usage is stored per month (usage/YYYY-MM.json): a write rewrites one small file and a range reads only its months.
func (s *Store) usageDir() string { return filepath.Join(s.root, "usage") }

func (s *Store) usagePath(month string) string { return filepath.Join(s.usageDir(), month+".json") }

// UsageDimensions are the columns usage can be grouped by.
var UsageDimensions = []string{"date", "provider", "model", "device", "repository"}

// Usage returns rows dated within [from, to] (YYYY-MM-DD; empty means unbounded). A non-empty groupBy keeps only
// those dimensions and sums the others away.
func (s *Store) Usage(from, to string, groupBy []string) ([]UsageRow, error) {
	s.usageMu.Lock()
	defer s.usageMu.Unlock()
	files, err := os.ReadDir(s.usageDir())
	if os.IsNotExist(err) {
		return []UsageRow{}, nil
	}
	if err != nil {
		return nil, err
	}
	keep := map[string]bool{}
	for _, name := range groupBy {
		keep[name] = true
	}
	totals := map[string]UsageRow{}
	for _, file := range files {
		month, ok := strings.CutSuffix(file.Name(), ".json")
		if !ok || len(month) != 7 || (from != "" && month < from[:7]) || (to != "" && month > to[:7]) {
			continue
		}
		rows, err := s.readUsage(month)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if (from != "" && row.Date < from) || (to != "" && row.Date > to) {
				continue
			}
			if len(keep) == 0 {
				// Each month's rows are already unique; nothing to sum.
				totals[row.key()] = row
				continue
			}
			{
				row.Date, row.Provider, row.Model = pick(keep["date"], row.Date), pick(keep["provider"], row.Provider), pick(keep["model"], row.Model)
				row.Device, row.Repository = pick(keep["device"], row.Device), pick(keep["repository"], row.Repository)
			}
			totals[row.key()] = addRow(totals[row.key()], row)
		}
	}
	keys := make([]string, 0, len(totals))
	for key := range totals {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]UsageRow, len(keys))
	for i, key := range keys {
		out[i] = totals[key]
	}
	return out, nil
}

func pick(keep bool, value string) string {
	if keep {
		return value
	}
	return ""
}

func addRow(total, row UsageRow) UsageRow {
	total.Date, total.Provider, total.Model, total.Device, total.Repository = row.Date, row.Provider, row.Model, row.Device, row.Repository
	total.Input += row.Input
	total.Output += row.Output
	total.CacheRead += row.CacheRead
	total.CacheWrite += row.CacheWrite
	total.Cost += row.Cost
	total.Turns += row.Turns
	return total
}

// readUsage returns a month's rows keyed by dimensions, from memory after the first read. Callers hold usageMu and
// must not modify the map; addUsage replaces it.
func (s *Store) readUsage(month string) (map[string]UsageRow, error) {
	if rows, ok := s.usageCache[month]; ok {
		return rows, nil
	}
	rows, err := s.loadUsage(month)
	if err != nil {
		return nil, err
	}
	if s.usageCache == nil {
		s.usageCache = map[string]map[string]UsageRow{}
	}
	s.usageCache[month] = rows
	return rows, nil
}

func (s *Store) loadUsage(month string) (map[string]UsageRow, error) {
	rows := map[string]UsageRow{}
	data, err := readRegular(s.usagePath(month))
	if os.IsNotExist(err) {
		return rows, nil
	}
	if err != nil {
		return nil, err
	}
	var list []UsageRow
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("decode usage %s: %w", month, err)
	}
	for _, row := range list {
		rows[row.key()] = row
	}
	return rows, nil
}

func (s *Store) addUsage(rows []UsageRow) error {
	byMonth := map[string][]UsageRow{}
	for _, row := range rows {
		byMonth[row.Date[:7]] = append(byMonth[row.Date[:7]], row)
	}
	if len(byMonth) == 0 {
		return nil
	}
	s.usageMu.Lock()
	defer s.usageMu.Unlock()
	if err := os.MkdirAll(s.usageDir(), 0o700); err != nil {
		return err
	}
	for month, added := range byMonth {
		cached, err := s.readUsage(month)
		if err != nil {
			return err
		}
		current := make(map[string]UsageRow, len(cached)+len(added))
		for key, row := range cached {
			current[key] = row
		}
		for _, row := range added {
			current[row.key()] = addRow(current[row.key()], row)
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
		if err := writeAtomic(s.usagePath(month), data); err != nil {
			return err
		}
		s.usageCache[month] = current
	}
	return nil
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
