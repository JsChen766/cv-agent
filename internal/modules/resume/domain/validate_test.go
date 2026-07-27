package domain

import (
	"encoding/json"
	"testing"
)

func validPublish() Publish {
	return Publish{
		Title:           "Product Manager Resume",
		Structured:      json.RawMessage(`{"language":"zh-CN","sections":[]}`),
		SchemaVersion:   DefaultSchemaVersion,
		Status:          StatusActive,
		QualityStatus:   QualityPassed,
		QualityIssues:   json.RawMessage(`[]`),
		Score:           json.RawMessage(`{}`),
		EvidenceSummary: json.RawMessage(`[]`),
		RiskSummary:     json.RawMessage(`[]`),
		MissingInfo:     json.RawMessage(`[]`),
	}
}

func TestPublishValidate(t *testing.T) {
	if err := validPublish().Validate(); err != nil {
		t.Fatalf("expected valid publish, got %v", err)
	}
	long := make([]byte, maxTitle+1)
	for i := range long {
		long[i] = 'a'
	}
	cases := map[string]Publish{
		"empty title":  func() Publish { p := validPublish(); p.Title = "   "; return p }(),
		"long title":   func() Publish { p := validPublish(); p.Title = string(long); return p }(),
		"bad status":   func() Publish { p := validPublish(); p.Status = "x"; return p }(),
		"bad quality":  func() Publish { p := validPublish(); p.QualityStatus = "x"; return p }(),
		"blank schema": func() Publish { p := validPublish(); p.SchemaVersion = ""; return p }(),
		"structured array": func() Publish {
			p := validPublish()
			p.Structured = json.RawMessage(`[]`)
			return p
		}(),
		"score array": func() Publish {
			p := validPublish()
			p.Score = json.RawMessage(`[]`)
			return p
		}(),
		"issues object": func() Publish {
			p := validPublish()
			p.QualityIssues = json.RawMessage(`{}`)
			return p
		}(),
		"bad expected version": func() Publish {
			p := validPublish()
			zero := int64(0)
			p.ExpectedVersion = &zero
			return p
		}(),
	}
	for name, input := range cases {
		if err := input.Validate(); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestMetadataPatchValidate(t *testing.T) {
	title := "Renamed"
	valid := MetadataPatch{ExpectedVersion: 1, Title: &title}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid patch, got %v", err)
	}
	if err := (MetadataPatch{ExpectedVersion: 0, Title: &title}).Validate(); err == nil {
		t.Error("expected error for version < 1")
	}
	if err := (MetadataPatch{ExpectedVersion: 1}).Validate(); err == nil {
		t.Error("expected error for empty patch")
	}
	clear := MetadataPatch{ExpectedVersion: 2, TargetRole: NewPatchValue(nil)}
	if err := clear.Validate(); err != nil {
		t.Errorf("clearing nullable field should be valid: %v", err)
	}
	bad := "x"
	badStatus := MetadataPatch{ExpectedVersion: 1, Status: (*Status)(&bad)}
	if err := badStatus.Validate(); err == nil {
		t.Error("expected error for bad status")
	}
}
