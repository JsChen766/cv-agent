package domain

import (
	"time"
	"unicode/utf8"
)

// InterviewType enumerates interview round formats.
type InterviewType string

const (
	InterviewPhone     InterviewType = "phone"
	InterviewVideo     InterviewType = "video"
	InterviewOnsite    InterviewType = "onsite"
	InterviewHR        InterviewType = "hr"
	InterviewTechnical InterviewType = "technical"
	InterviewCase      InterviewType = "case"
	InterviewOther     InterviewType = "other"
)

// InterviewStatus enumerates interview round lifecycle states.
type InterviewStatus string

const (
	InterviewScheduled InterviewStatus = "scheduled"
	InterviewCompleted InterviewStatus = "completed"
	InterviewCanceled  InterviewStatus = "canceled"
)

const (
	maxTimezone    = 64
	maxLocation    = 4096
	maxInterviewer = 240
	maxDuration    = 1440
)

const defaultTimezone = "Asia/Shanghai"

// InterviewRound is a synchronized child of an application.
type InterviewRound struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	ApplicationID        string
	RoundNumber          int
	InterviewType        InterviewType
	ScheduledAt          *time.Time
	Timezone             string
	DurationMinutes      *int
	LocationOrLink       *string
	Interviewer          *string
	Status               InterviewStatus
}

// InterviewWrite is the validated payload for creating or replacing a round.
type InterviewWrite struct {
	ID              string
	ExpectedVersion *int64
	RoundNumber     int
	InterviewType   InterviewType
	ScheduledAt     *time.Time
	Timezone        string
	DurationMinutes *int
	LocationOrLink  *string
	Interviewer     *string
	Status          InterviewStatus
}

// Validate enforces interview round constraints and applies the timezone default.
func (w *InterviewWrite) Validate() error {
	if w.ExpectedVersion != nil && *w.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if w.RoundNumber < 1 {
		return ErrInvalidInput
	}
	if !validInterviewType(w.InterviewType) || !validInterviewStatus(w.Status) {
		return ErrInvalidInput
	}
	if w.Timezone == "" {
		w.Timezone = defaultTimezone
	}
	if utf8.RuneCountInString(w.Timezone) > maxTimezone {
		return ErrInvalidInput
	}
	if w.DurationMinutes != nil && (*w.DurationMinutes < 1 || *w.DurationMinutes > maxDuration) {
		return ErrInvalidInput
	}
	if !checkOptional(w.LocationOrLink, maxLocation) ||
		!checkOptional(w.Interviewer, maxInterviewer) {
		return ErrInvalidInput
	}
	return nil
}

func validInterviewType(t InterviewType) bool {
	switch t {
	case InterviewPhone, InterviewVideo, InterviewOnsite, InterviewHR,
		InterviewTechnical, InterviewCase, InterviewOther:
		return true
	default:
		return false
	}
}

func validInterviewStatus(s InterviewStatus) bool {
	switch s {
	case InterviewScheduled, InterviewCompleted, InterviewCanceled:
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
