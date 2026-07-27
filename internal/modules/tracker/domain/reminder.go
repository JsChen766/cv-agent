package domain

import (
	"time"
	"unicode/utf8"
)

// ReminderStatus enumerates reminder lifecycle states. The cloud only stores
// the state; the APP triggers local system notifications.
type ReminderStatus string

const (
	ReminderScheduled ReminderStatus = "scheduled"
	ReminderDelivered ReminderStatus = "delivered"
	ReminderDismissed ReminderStatus = "dismissed"
	ReminderCanceled  ReminderStatus = "canceled"
)

const maxReminderTitle = 240

// Reminder is a synchronized child of an application.
type Reminder struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	ApplicationID        string
	InterviewRoundID     *string
	Title                string
	RemindAt             time.Time
	Status               ReminderStatus
	DeliveredAt          *time.Time
}

// ReminderWrite is the validated payload for creating or replacing a reminder.
type ReminderWrite struct {
	ID               string
	ExpectedVersion  *int64
	ApplicationID    string
	InterviewRoundID *string
	Title            string
	RemindAt         time.Time
	Status           ReminderStatus
	DeliveredAt      *time.Time
}

// Validate enforces reminder constraints.
func (w ReminderWrite) Validate() error {
	if w.ExpectedVersion != nil && *w.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	length := utf8.RuneCountInString(w.Title)
	if length < 1 || length > maxReminderTitle {
		return ErrInvalidInput
	}
	if w.RemindAt.IsZero() {
		return ErrInvalidInput
	}
	if !validReminderStatus(w.Status) {
		return ErrInvalidInput
	}
	return nil
}

func validReminderStatus(s ReminderStatus) bool {
	switch s {
	case ReminderScheduled, ReminderDelivered, ReminderDismissed, ReminderCanceled:
		return true
	default:
		return false
	}
}
