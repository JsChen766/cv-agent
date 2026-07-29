package domain

import (
	"errors"
	"time"
)

// Errors mapped to stable HTTP responses.
var (
	ErrNotFound        = errors.New("experience not found")
	ErrVersionConflict = errors.New("entity version conflict")
	ErrInvalidInput    = errors.New("invalid experience input")
)

// Category enumerates the allowed experience kinds.
type Category string

const (
	CategoryWork      Category = "work"
	CategoryProject   Category = "project"
	CategoryEducation Category = "education"
	CategoryVolunteer Category = "volunteer"
	CategoryOther     Category = "other"
)

// Status enumerates the lifecycle states of an experience.
type Status string

const (
	StatusActive   Status = "active"
	StatusArchived Status = "archived"
)

// RevisionSource enumerates how a content revision was produced.
type RevisionSource string

const (
	SourceManual       RevisionSource = "manual"
	SourceImport       RevisionSource = "import"
	SourceAppGenerated RevisionSource = "app_generated"
)

// Revision is an immutable snapshot of experience content.
type Revision struct {
	ID              string
	UserID          string
	ExperienceID    string
	RevisionNumber  int
	Content         string
	Source          RevisionSource
	RevisionHash    string
	CreatedByDevice *string
	CreatedAt       time.Time
}

// Experience is a synchronized asset owned by a user. Content lives only in
// immutable revisions; the aggregate references the current revision.
type Experience struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	Category             Category
	Title                string
	Organization         *string
	Role                 *string
	Location             *string
	StartDate            *string
	EndDate              *string
	Tags                 []string
	Status               Status
	CurrentRevisionID    *string
	CurrentRevision      *Revision
	Revisions            []Revision
}

// Create is the validated payload for a new experience and its first revision.
type Create struct {
	ID           string
	RevisionID   string
	Category     Category
	Title        string
	Content      string
	Organization *string
	Role         *string
	Location     *string
	StartDate    *string
	EndDate      *string
	Tags         []string
	Status       Status
	Source       RevisionSource
}

// Update is the complete atomic PUT state applied under an optimistic lock.
// RevisionID is used only when Content changes.
type Update struct {
	ExpectedVersion int64
	RevisionID      string
	Category        Category
	Title           string
	Content         string
	Organization    *string
	Role            *string
	Location        *string
	StartDate       *string
	EndDate         *string
	Tags            []string
	Status          Status
	Source          RevisionSource
}
