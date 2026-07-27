package domain

import (
	"errors"
	"time"
)

// Errors mapped to stable HTTP responses.
var (
	ErrNotFound        = errors.New("jd not found")
	ErrVersionConflict = errors.New("entity version conflict")
	ErrInvalidInput    = errors.New("invalid jd input")
)

// Status enumerates the lifecycle states of a JD.
type Status string

const (
	StatusActive   Status = "active"
	StatusArchived Status = "archived"
)

// SourceKind enumerates how a JD was captured.
type SourceKind string

const (
	SourceManual   SourceKind = "manual"
	SourcePasted   SourceKind = "pasted"
	SourceBrowser  SourceKind = "browser"
	SourceImported SourceKind = "imported"
)

// RequirementsOrigin enumerates how the structured requirements were produced.
type RequirementsOrigin string

const (
	OriginManual       RequirementsOrigin = "manual"
	OriginAppExtracted RequirementsOrigin = "app_extracted"
)

// Importance is the canonical requirement importance stored in the database.
type Importance string

const (
	ImportanceMustHave  Importance = "must_have"
	ImportancePreferred Importance = "preferred"
	ImportanceOptional  Importance = "optional"
)

// RequirementCategory is the canonical requirement category.
type RequirementCategory string

const (
	CategoryQualification  RequirementCategory = "qualification"
	CategoryResponsibility RequirementCategory = "responsibility"
	CategoryTechnology     RequirementCategory = "technology"
	CategoryDomain         RequirementCategory = "domain"
	CategorySoftSkill      RequirementCategory = "soft_skill"
	CategoryOther          RequirementCategory = "other"
)

// Requirement is a structured JD requirement with a stable ID.
type Requirement struct {
	ID         string
	Text       string
	Category   RequirementCategory
	Importance Importance
	Keywords   []string
	Weight     *float64
	SortOrder  int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// JobDescription is a synchronized asset owned by a user.
type JobDescription struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	Title                string
	Company              *string
	TargetRole           *string
	SourceKind           SourceKind
	SourceURL            *string
	RawText              string
	JdHash               string
	RequirementsOrigin   RequirementsOrigin
	Status               Status
	Requirements         []Requirement
}

// Write is the validated payload shared by create and replace.
type Write struct {
	ID                 string
	ExpectedVersion    int64
	Title              string
	Company            *string
	TargetRole         *string
	SourceKind         SourceKind
	SourceURL          *string
	RawText            string
	RequirementsOrigin RequirementsOrigin
	Status             Status
	Requirements       []Requirement
}
