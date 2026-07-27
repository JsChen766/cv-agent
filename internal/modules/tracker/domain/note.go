package domain

import (
	"time"
	"unicode/utf8"
)

// NoteType enumerates the kinds of application notes.
type NoteType string

const (
	NoteGeneral   NoteType = "general"
	NoteInterview NoteType = "interview"
	NoteFollowUp  NoteType = "follow_up"
	NoteCompany   NoteType = "company"
)

const maxNoteContent = 50000

// Note is a synchronized child of an application, optionally tied to a round.
type Note struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	ApplicationID        string
	InterviewRoundID     *string
	NoteType             NoteType
	Content              string
}

// NoteWrite is the validated payload for creating or replacing a note.
type NoteWrite struct {
	ID               string
	ExpectedVersion  *int64
	InterviewRoundID *string
	NoteType         NoteType
	Content          string
}

// Validate enforces note constraints.
func (w NoteWrite) Validate() error {
	if w.ExpectedVersion != nil && *w.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if !validNoteType(w.NoteType) {
		return ErrInvalidInput
	}
	length := utf8.RuneCountInString(w.Content)
	if length < 1 || length > maxNoteContent {
		return ErrInvalidInput
	}
	return nil
}

func validNoteType(t NoteType) bool {
	switch t {
	case NoteGeneral, NoteInterview, NoteFollowUp, NoteCompany:
		return true
	default:
		return false
	}
}
