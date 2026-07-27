package domain

import (
	"errors"
	"time"
)

// Errors mapped to stable HTTP responses across tracker entities.
var (
	ErrNotFound          = errors.New("tracker entity not found")
	ErrVersionConflict   = errors.New("entity version conflict")
	ErrInvalidInput      = errors.New("invalid tracker input")
	ErrIllegalTransition = errors.New("illegal status transition")
	ErrRoundConflict     = errors.New("interview round number conflict")
	ErrOperationReused   = errors.New("operation id reused")
	ErrDuplicate         = errors.New("duplicate tracker entity")
)

// Status enumerates the application tracker board columns.
type Status string

const (
	StatusApplied      Status = "applied"
	StatusScreening    Status = "screening"
	StatusInterviewing Status = "interviewing"
	StatusOffer        Status = "offer"
	StatusRejected     Status = "rejected"
	StatusNoResponse   Status = "no_response"
)

// DeliveryMethod enumerates how the application was submitted.
type DeliveryMethod string

const (
	DeliveryFormFill  DeliveryMethod = "form_fill"
	DeliveryEmailFill DeliveryMethod = "email_fill"
	DeliveryManual    DeliveryMethod = "manual"
	DeliveryOther     DeliveryMethod = "other"
)

// Source enumerates how the record was captured.
type Source string

const (
	SourceManual  Source = "manual"
	SourceBrowser Source = "browser"
	SourceEmail   Source = "email"
	SourceOther   Source = "other"
)

// Application is a synchronized tracker record owned by a user. Company, role
// and title snapshots are frozen at write time and never follow JD/Resume edits.
type Application struct {
	ID                   string
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
	LastModifiedDeviceID *string
	JdID                 *string
	ResumeID             *string
	CompanyName          string
	RoleName             string
	JdTitleSnapshot      *string
	ResumeTitleSnapshot  *string
	DeliveryMethod       DeliveryMethod
	TargetURL            *string
	AppliedAt            *time.Time
	Status               Status
	PendingConfirmation  bool
	Source               Source
	DedupeKey            *string
	CompanyBusiness      *string
	RoleSummary          *string
	CompanyCulture       *string
	RejectionReason      *string
}

// Create is the validated payload for recording an application.
type Create struct {
	ID                  string
	JdID                *string
	ResumeID            *string
	CompanyName         string
	RoleName            string
	JdTitleSnapshot     *string
	ResumeTitleSnapshot *string
	DeliveryMethod      DeliveryMethod
	TargetURL           *string
	AppliedAt           *time.Time
	PendingConfirmation bool
	Source              Source
	DedupeKey           *string
	CompanyBusiness     *string
	RoleSummary         *string
	CompanyCulture      *string
}

// Update is the atomic PUT payload applied under an optimistic lock. It never
// changes status; transitions use the dedicated command.
type Update struct {
	ExpectedVersion     int64
	JdID                *string
	ResumeID            *string
	CompanyName         string
	RoleName            string
	DeliveryMethod      DeliveryMethod
	TargetURL           *string
	AppliedAt           *time.Time
	PendingConfirmation bool
	CompanyBusiness     *string
	RoleSummary         *string
	CompanyCulture      *string
	RejectionReason     *string
}

// Transition is the validated payload for a status change command.
type Transition struct {
	ToStatus        Status
	ExpectedVersion int64
	OccurredAt      time.Time
	Reason          *string
	OperationID     string
}

// StatusEvent is an immutable audit record of a single transition.
type StatusEvent struct {
	ID              string
	UserID          string
	ApplicationID   string
	FromStatus      *Status
	ToStatus        Status
	Reason          *string
	OccurredAt      time.Time
	CreatedByDevice *string
	OperationID     string
	CreatedAt       time.Time
}
