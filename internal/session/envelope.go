package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	FormatVersion      = 1
	MaxEnvelopeBytes   = 16 << 20
	MaxEntries         = 100_000
	MaxEntryBytes      = 1 << 20
	MaxSessionIDLength = 128
	MaxTitleLength     = 2_000
	MaxWorkspaceField  = 4_096
	MaxEntryIDLength   = 128
	MaxParentDepth     = 64
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var hexCommit = regexp.MustCompile(`^[0-9a-fA-F]{7,128}$`)

type Workspace struct {
	GitRemote string `json:"gitRemote"`
	Branch    string `json:"branch"`
	Commit    string `json:"commit"`
	// Wip is a working-tree snapshot pushed to refs/pi-sync/<session id>.
	Wip *WorkspaceSnapshot `json:"wip,omitempty"`
}

type WorkspaceSnapshot struct {
	Commit string `json:"commit"`
	Branch string `json:"branch"`
}

const UnscopedRepository = "none"

func RepositoryIdentity(workspace *Workspace) string {
	if workspace == nil {
		return UnscopedRepository
	}
	return NormalizeGitRemote(workspace.GitRemote)
}

func NormalizeGitRemote(value string) string {
	remote := strings.TrimSpace(value)
	if remote == "" {
		return ""
	}
	if !strings.Contains(remote, "://") {
		if separator := strings.IndexByte(remote, ':'); separator > 0 {
			host := remote[:separator]
			if at := strings.LastIndexByte(host, '@'); at >= 0 {
				host = host[at+1:]
			}
			if host != "" && !strings.Contains(host, "/") && separator+1 < len(remote) {
				return repositoryHostPath(host, remote[separator+1:])
			}
		}
		return remote
	}
	parsed, err := url.Parse(remote)
	if err != nil || parsed.Hostname() == "" {
		return remote
	}
	host := strings.ToLower(parsed.Host)
	return repositoryHostPath(host, parsed.Path)
}

func repositoryHostPath(host, path string) string {
	path = strings.Trim(path, "/")
	if len(path) >= 4 && strings.EqualFold(path[len(path)-4:], ".git") {
		path = path[:len(path)-4]
	}
	if path == "" {
		return strings.ToLower(host)
	}
	return strings.ToLower(host) + "/" + path
}

type Envelope struct {
	FormatVersion    int               `json:"formatVersion"`
	SessionID        string            `json:"sessionId"`
	PiSessionVersion int               `json:"piSessionVersion"`
	CreatedAt        string            `json:"createdAt"`
	ParentSessionID  *string           `json:"parentSessionId"`
	HeadEntryID      string            `json:"headEntryId"`
	Title            string            `json:"title"`
	Entries          []json.RawMessage `json:"entries"`
	Workspace        *Workspace        `json:"workspace,omitempty"`
}

type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Field == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func invalid(field, message string) error {
	return &ValidationError{Field: field, Message: message}
}

// Decode parses one JSON value and rejects trailing values. The input is
// bounded so malformed clients cannot use an unbounded request body or deeply
// nested JSON to exhaust the server.
func Decode(data []byte) (Envelope, error) {
	if len(data) == 0 {
		return Envelope{}, invalid("body", "request body is empty")
	}
	if len(data) > MaxEnvelopeBytes {
		return Envelope{}, invalid("body", "request body is too large")
	}
	if !json.Valid(data) {
		return Envelope{}, invalid("body", "request body is not valid JSON")
	}
	if depth := jsonDepth(data); depth > MaxParentDepth {
		return Envelope{}, invalid("body", "JSON nesting is too deep")
	}

	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return Envelope{}, invalid("body", "request body must be a JSON object")
	}
	for _, field := range []string{"formatVersion", "sessionId", "piSessionVersion", "createdAt", "parentSessionId", "headEntryId", "title", "entries"} {
		if _, ok := object[field]; !ok {
			return Envelope{}, invalid(field, "field is required")
		}
	}
	for _, field := range []string{"formatVersion", "sessionId", "piSessionVersion", "createdAt", "headEntryId", "title", "entries"} {
		if bytes.Equal(bytes.TrimSpace(object[field]), []byte("null")) {
			return Envelope{}, invalid(field, "must not be null")
		}
	}
	if workspace, ok := object["workspace"]; ok && bytes.Equal(bytes.TrimSpace(workspace), []byte("null")) {
		return Envelope{}, invalid("workspace", "must be omitted or an object")
	}

	var envelope Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Envelope{}, invalid("body", "request body must be a JSON object")
	}
	if err := Validate(envelope); err != nil {
		return Envelope{}, err
	}
	return envelope, nil
}

// DecodeReader is useful for callers that already have an io.Reader. It
// reads at most one byte beyond the protocol limit and then delegates to
// Decode for structural validation.
func DecodeReader(r io.Reader) (Envelope, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxEnvelopeBytes+1))
	if err != nil {
		return Envelope{}, err
	}
	return Decode(data)
}

func CanonicalBytes(envelope Envelope) ([]byte, error) {
	if err := Validate(envelope); err != nil {
		return nil, err
	}
	return json.Marshal(envelope)
}

func Validate(envelope Envelope) error {
	if envelope.FormatVersion != FormatVersion {
		return invalid("formatVersion", fmt.Sprintf("unsupported format version %d", envelope.FormatVersion))
	}
	if !validID(envelope.SessionID, MaxSessionIDLength) {
		return invalid("sessionId", "must be a non-empty portable identifier")
	}
	if envelope.PiSessionVersion < 1 || envelope.PiSessionVersion > 100 {
		return invalid("piSessionVersion", "must be between 1 and 100")
	}
	if _, err := time.Parse(time.RFC3339Nano, envelope.CreatedAt); err != nil {
		return invalid("createdAt", "must be an RFC3339 timestamp")
	}
	if envelope.ParentSessionID != nil && !validID(*envelope.ParentSessionID, MaxSessionIDLength) {
		return invalid("parentSessionId", "must be null or a portable identifier")
	}
	if len(envelope.Title) > MaxTitleLength {
		return invalid("title", "is too long")
	}
	if strings.IndexByte(envelope.Title, 0) >= 0 {
		return invalid("title", "contains a NUL byte")
	}
	if len(envelope.Entries) > MaxEntries {
		return invalid("entries", "contains too many entries")
	}

	ids := make(map[string]string, len(envelope.Entries))
	parents := make(map[string]string, len(envelope.Entries))
	for index, raw := range envelope.Entries {
		field := fmt.Sprintf("entries[%d]", index)
		if len(raw) == 0 || len(raw) > MaxEntryBytes {
			return invalid(field, "entry is empty or too large")
		}
		if !json.Valid(raw) {
			return invalid(field, "entry is not valid JSON")
		}
		if jsonDepth(raw) > MaxParentDepth {
			return invalid(field, "entry JSON nesting is too deep")
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil || object == nil {
			return invalid(field, "entry must be a JSON object")
		}
		typeName, ok, err := rawString(object, "type")
		if err != nil || !ok || typeName == "" || len(typeName) > 128 {
			return invalid(field+".type", "must be a non-empty string")
		}
		entryID, ok, err := rawString(object, "id")
		if err != nil || !ok || !validID(entryID, MaxEntryIDLength) {
			return invalid(field+".id", "must be a unique portable identifier")
		}
		if _, exists := ids[entryID]; exists {
			return invalid(field+".id", "duplicates another entry id")
		}
		ids[entryID] = typeName

		parent, present := object["parentId"]
		if !present {
			return invalid(field+".parentId", "is required")
		}
		parentID, isNull, err := rawNullableString(parent)
		if err != nil || (!isNull && !validID(parentID, MaxEntryIDLength)) {
			return invalid(field+".parentId", "must be null or an entry identifier")
		}
		parents[entryID] = parentID

		timestamp, ok, err := rawString(object, "timestamp")
		if err != nil || !ok {
			return invalid(field+".timestamp", "must be an ISO timestamp string")
		}
		if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
			return invalid(field+".timestamp", "must be an RFC3339 timestamp")
		}
	}

	if len(envelope.Entries) == 0 {
		if envelope.HeadEntryID != "" {
			return invalid("headEntryId", "must be empty when entries is empty")
		}
	} else {
		if !validID(envelope.HeadEntryID, MaxEntryIDLength) {
			return invalid("headEntryId", "must identify an entry")
		}
		if _, ok := ids[envelope.HeadEntryID]; !ok {
			return invalid("headEntryId", "does not belong to entries")
		}
		roots := 0
		for id, parent := range parents {
			if parent == "" {
				roots++
				continue
			}
			if _, ok := ids[parent]; !ok {
				return invalid("entries", fmt.Sprintf("entry %q refers to missing parent %q", id, parent))
			}
		}
		if roots != 1 {
			return invalid("entries", "must contain exactly one root entry")
		}
		// Ids are unique, parents exist and there is one root, so every entry the
		// root cannot reach sits on a cycle. One walk keeps this linear.
		children := make(map[string][]string, len(parents))
		root := ""
		for id, parent := range parents {
			if parent == "" {
				root = id
			} else {
				children[parent] = append(children[parent], id)
			}
		}
		reached := map[string]struct{}{root: {}}
		for queue := []string{root}; len(queue) > 0; queue = queue[1:] {
			for _, child := range children[queue[0]] {
				reached[child] = struct{}{}
				queue = append(queue, child)
			}
		}
		if len(reached) != len(ids) {
			for id := range ids {
				if _, ok := reached[id]; !ok {
					return invalid("entries", fmt.Sprintf("entry graph contains a cycle at %q", id))
				}
			}
		}
	}

	if envelope.Workspace != nil {
		if len(envelope.Workspace.GitRemote) == 0 || len(envelope.Workspace.GitRemote) > MaxWorkspaceField || strings.ContainsAny(envelope.Workspace.GitRemote, "\r\n\x00") {
			return invalid("workspace.gitRemote", "must be a bounded non-empty value")
		}
		if !validBranch(envelope.Workspace.Branch) {
			return invalid("workspace.branch", "must be a portable branch name")
		}
		if !hexCommit.MatchString(envelope.Workspace.Commit) {
			return invalid("workspace.commit", "must be a hexadecimal commit identifier")
		}
		if wip := envelope.Workspace.Wip; wip != nil {
			if !hexCommit.MatchString(wip.Commit) {
				return invalid("workspace.wip.commit", "must be a hexadecimal commit identifier")
			}
			if !validBranch(wip.Branch) {
				return invalid("workspace.wip.branch", "must be a portable branch name")
			}
		}
	}
	return nil
}

func validID(value string, max int) bool {
	return len(value) > 0 && len(value) <= max && safeID.MatchString(value) && !strings.ContainsAny(value, "\r\n\x00")
}

func validBranch(value string) bool {
	if value == "" || len(value) > MaxWorkspaceField || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	return !strings.HasPrefix(value, "-") && !strings.Contains(value, "..")
}

func rawString(object map[string]json.RawMessage, key string) (string, bool, error) {
	raw, ok := object[key]
	if !ok {
		return "", false, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, err
	}
	return value, true, nil
}

func rawNullableString(raw json.RawMessage) (string, bool, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", true, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false, err
	}
	return value, false, nil
}

// jsonDepth counts structural nesting without interpreting braces inside JSON
// strings. It is deliberately small and independent of encoding/json's parser
// so the bound is applied before unmarshalling arbitrary entry data.
func jsonDepth(data []byte) int {
	depth, max := 0, 0
	inString, escaped := false, false
	for _, character := range data {
		if inString {
			if escaped {
				escaped = false
			} else if character == '\\' {
				escaped = true
			} else if character == '"' {
				inString = false
			}
			continue
		}
		switch character {
		case '"':
			inString = true
		case '{', '[':
			depth++
			if depth > max {
				max = depth
			}
		case '}', ']':
			if depth > 0 {
				depth--
			}
		}
	}
	return max
}

// SafeID reports whether an ID can safely be used as the final component of a
// session filename and URL path.
func SafeID(value string) bool { return validID(value, MaxSessionIDLength) }

// IsValidationError lets API callers classify bad client envelopes without
// exposing implementation-specific errors.
func IsValidationError(err error) bool {
	var validation *ValidationError
	return errors.As(err, &validation)
}
