package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	maxTitle         = 240
	maxTargetRole    = 240
	maxTargetCompany = 240
	maxSchemaVersion = 80
	maxStructured    = 512 * 1024
)

// Validate enforces domain constraints for a resume create or replace.
func (p Publish) Validate() error {
	if !validTitle(p.Title) {
		return ErrInvalidInput
	}
	if !validStatus(p.Status) || !validQuality(p.QualityStatus) {
		return ErrInvalidInput
	}
	if !checkOptional(p.TargetRole, maxTargetRole) ||
		!checkOptional(p.TargetCompany, maxTargetCompany) {
		return ErrInvalidInput
	}
	if p.SchemaVersion == "" || utf8.RuneCountInString(p.SchemaVersion) > maxSchemaVersion {
		return ErrInvalidInput
	}
	if !validObject(p.Structured) || len(p.Structured) > maxStructured {
		return ErrInvalidInput
	}
	if !validObject(p.Score) {
		return ErrInvalidInput
	}
	if !validArray(p.QualityIssues) || !validArray(p.EvidenceSummary) ||
		!validArray(p.RiskSummary) || !validArray(p.MissingInfo) {
		return ErrInvalidInput
	}
	if p.ExpectedVersion != nil && *p.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	return nil
}

// Validate enforces domain constraints for a metadata patch.
func (p MetadataPatch) Validate() error {
	if p.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if p.Title == nil && p.Status == nil &&
		!p.TargetRole.Set && !p.TargetCompany.Set && !p.JdID.Set {
		return ErrInvalidInput
	}
	if p.Title != nil && !validTitle(*p.Title) {
		return ErrInvalidInput
	}
	if p.Status != nil && !validStatus(*p.Status) {
		return ErrInvalidInput
	}
	if !checkOptional(p.TargetRole.Value, maxTargetRole) ||
		!checkOptional(p.TargetCompany.Value, maxTargetCompany) {
		return ErrInvalidInput
	}
	return nil
}

func validTitle(title string) bool {
	length := utf8.RuneCountInString(strings.TrimSpace(title))
	return length >= 1 && length <= maxTitle
}

func validStatus(s Status) bool {
	switch s {
	case StatusDraft, StatusActive, StatusPublished, StatusArchived:
		return true
	default:
		return false
	}
}

func validQuality(s QualityStatus) bool {
	switch s {
	case QualityUnverified, QualityPassed, QualityNeedsRevision, QualityFailed:
		return true
	default:
		return false
	}
}

func checkOptional(value *string, limit int) bool {
	if value == nil {
		return true
	}
	return utf8.RuneCountInString(*value) <= limit
}

func validObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	var value map[string]any
	return json.Unmarshal(trimmed, &value) == nil
}

func validArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	var value []any
	return json.Unmarshal(trimmed, &value) == nil
}
