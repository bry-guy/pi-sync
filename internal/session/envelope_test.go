package session

import (
	"encoding/json"
	"strings"
	"testing"
)

func testEnvelope() Envelope {
	return Envelope{
		FormatVersion:    FormatVersion,
		SessionID:        "session-1",
		PiSessionVersion: 3,
		CreatedAt:        "2026-01-01T00:00:00.000Z",
		HeadEntryID:      "b",
		Title:            "test",
		Entries: []json.RawMessage{
			json.RawMessage(`{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user"}}`),
			json.RawMessage(`{"type":"future_entry","id":"b","parentId":"a","timestamp":"2026-01-01T00:00:02.000Z","newField":{"keep":true}}`),
		},
	}
}

func TestValidatePreservesUnknownEntryTypes(t *testing.T) {
	envelope := testEnvelope()
	if err := Validate(envelope); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	data, err := CanonicalBytes(envelope)
	if err != nil {
		t.Fatalf("CanonicalBytes() error = %v", err)
	}
	decoded, err := Decode(data)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if string(decoded.Entries[1]) != string(envelope.Entries[1]) {
		t.Fatalf("unknown entry changed: %s", decoded.Entries[1])
	}
}

func TestValidateRejectsBrokenGraph(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Envelope)
	}{
		{"missing parent", func(value *Envelope) {
			value.Entries[1] = json.RawMessage(`{"type":"message","id":"b","parentId":"missing","timestamp":"2026-01-01T00:00:02Z"}`)
		}},
		{"wrong head", func(value *Envelope) { value.HeadEntryID = "missing" }},
		{"duplicate id", func(value *Envelope) {
			value.Entries[1] = json.RawMessage(`{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:02Z"}`)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := testEnvelope()
			test.edit(&value)
			if err := Validate(value); err == nil {
				t.Fatal("Validate() unexpectedly succeeded")
			}
		})
	}
}

func TestDecodeRejectsTrailingJSONAndDeepNesting(t *testing.T) {
	if _, err := Decode([]byte(`{"formatVersion":1} {}`)); err == nil {
		t.Fatal("trailing JSON was accepted")
	}
	deep := strings.Repeat("[", MaxParentDepth+2) + "0" + strings.Repeat("]", MaxParentDepth+2)
	if _, err := Decode([]byte(deep)); err == nil {
		t.Fatal("deep JSON was accepted")
	}
}
