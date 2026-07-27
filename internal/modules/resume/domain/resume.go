package domain

import (
	"encoding/json"
	"errors"
	"time"
)

// Errors mapped to stable HTTP responses.
var (
	ErrNotFound        = errors.New("resume not found")
	ErrVersionConflict = errors.New("entity version conflict")
	ErrContentConflict = errors.New("content hash conflict")
	ErrInvalidInput    = errors.New("invalid resume input")
	ErrDuplicate       = errors.New("resume already exists")
)

// Status enumerates the lifecycle states of a resume.
type Status string

const (
	StatusDraft     Status = "draft"
	StatusActive    Status = "active"
	StatusPublished Status = "published"
	StatusArchived  Status = "archived"
)

// QualityStatus enumerates the cloud quality gate state.
type QualityStatus string

const (
	QualityUnverified    QualityStatus = "unverified"
	QualityPassed        QualityStatus = "passed"
	QualityNeedsRevision QualityStatus = "needs_revision"
	QualityFailed        QualityStatus = "failed"
)

// DefaultSchemaVersion is applied when a publish omits schemaVersion.
const DefaultSchemaVersion = "resume-document-v1"

// Resume is a synchronized single-document cloud asset owned by a user. The
// structured document and its JSONB companions preserve the APP-internal
// snake_case contract and are stored verbatim.
type Resume struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	Title                string
	TargetRole           *string
	TargetCompany        *string
	JdID                 *string
	Structured           json.RawMessage
	Content              string
	ContentHash          string
	SchemaVersion        string
	Status               Status
	QualityStatus        QualityStatus
	QualityIssues        json.RawMessage
	QualityGateVersion   *string
	Score                json.RawMessage
	EvidenceSummary      json.RawMessage
	RiskSummary          json.RawMessage
	MissingInfo          json.RawMessage
}

// Publish is the validated payload for creating or replacing a resume. A
// replace must carry at least one stable optimistic-concurrency guard; creates
// ignore both guards.
type Publish struct {
	ID                  string
	ExpectedVersion     *int64
	ExpectedContentHash *string
	Title               string
	TargetRole          *string
	TargetCompany       *string
	JdID                *string
	Structured          json.RawMessage
	SchemaVersion       string
	Status              Status
	QualityStatus       QualityStatus
	QualityIssues       json.RawMessage
	QualityGateVersion  *string
	Score               json.RawMessage
	EvidenceSummary     json.RawMessage
	RiskSummary         json.RawMessage
	MissingInfo         json.RawMessage
}

// MetadataPatch updates lightweight fields under an optimistic lock without
// replacing the structured document.
type MetadataPatch struct {
	ExpectedVersion int64
	Title           *string
	Status          *Status
	TargetRole      patchString
	TargetCompany   patchString
	JdID            patchString
}

// patchString distinguishes an omitted field from an explicit null/value in a
// PATCH body so nullable metadata can be cleared or left untouched.
type patchString struct {
	Set   bool
	Value *string
}

// NewPatchValue marks a field as present with the supplied value (or null).
func NewPatchValue(value *string) patchString {
	return patchString{Set: true, Value: value}
}

// Get reports whether the field was supplied and its value.
func (p patchString) Get() (*string, bool) {
	return p.Value, p.Set
}
