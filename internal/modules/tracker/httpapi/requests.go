package httpapi

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

type applicationCreateRequest struct {
	ID                  string     `json:"id"`
	JdID                *string    `json:"jdId"`
	ResumeID            *string    `json:"resumeId"`
	CompanyName         string     `json:"companyName"`
	RoleName            string     `json:"roleName"`
	JdTitleSnapshot     *string    `json:"jdTitleSnapshot"`
	ResumeTitleSnapshot *string    `json:"resumeTitleSnapshot"`
	DeliveryMethod      string     `json:"deliveryMethod"`
	TargetURL           *string    `json:"targetUrl"`
	AppliedAt           *time.Time `json:"appliedAt"`
	PendingConfirmation bool       `json:"pendingConfirmation"`
	Source              string     `json:"source"`
	DedupeKey           *string    `json:"dedupeKey"`
	CompanyBusiness     *string    `json:"companyBusiness"`
	RoleSummary         *string    `json:"roleSummary"`
	CompanyCulture      *string    `json:"companyCulture"`
}

func (req applicationCreateRequest) toDomain() domain.Create {
	return domain.Create{
		ID: req.ID, JdID: req.JdID, ResumeID: req.ResumeID,
		CompanyName: req.CompanyName, RoleName: req.RoleName,
		JdTitleSnapshot: req.JdTitleSnapshot, ResumeTitleSnapshot: req.ResumeTitleSnapshot,
		DeliveryMethod: domain.DeliveryMethod(req.DeliveryMethod), TargetURL: req.TargetURL,
		AppliedAt: normalizeTime(req.AppliedAt), PendingConfirmation: req.PendingConfirmation,
		Source: domain.Source(req.Source), DedupeKey: req.DedupeKey,
		CompanyBusiness: req.CompanyBusiness, RoleSummary: req.RoleSummary,
		CompanyCulture: req.CompanyCulture,
	}
}

type applicationUpdateRequest struct {
	ExpectedVersion     int64      `json:"expectedVersion"`
	JdID                *string    `json:"jdId"`
	ResumeID            *string    `json:"resumeId"`
	CompanyName         string     `json:"companyName"`
	RoleName            string     `json:"roleName"`
	DeliveryMethod      string     `json:"deliveryMethod"`
	TargetURL           *string    `json:"targetUrl"`
	AppliedAt           *time.Time `json:"appliedAt"`
	PendingConfirmation bool       `json:"pendingConfirmation"`
	CompanyBusiness     *string    `json:"companyBusiness"`
	RoleSummary         *string    `json:"roleSummary"`
	CompanyCulture      *string    `json:"companyCulture"`
	RejectionReason     *string    `json:"rejectionReason"`
}

func (req applicationUpdateRequest) toDomain() domain.Update {
	return domain.Update{
		ExpectedVersion: req.ExpectedVersion, JdID: req.JdID, ResumeID: req.ResumeID,
		CompanyName: req.CompanyName, RoleName: req.RoleName,
		DeliveryMethod: domain.DeliveryMethod(req.DeliveryMethod), TargetURL: req.TargetURL,
		AppliedAt: normalizeTime(req.AppliedAt), PendingConfirmation: req.PendingConfirmation,
		CompanyBusiness: req.CompanyBusiness, RoleSummary: req.RoleSummary,
		CompanyCulture: req.CompanyCulture, RejectionReason: req.RejectionReason,
	}
}

type transitionRequest struct {
	ToStatus        string     `json:"toStatus"`
	ExpectedVersion int64      `json:"expectedVersion"`
	OccurredAt      *time.Time `json:"occurredAt"`
	Reason          *string    `json:"reason"`
	OperationID     string     `json:"operationId"`
}

func (req transitionRequest) toDomain() domain.Transition {
	transition := domain.Transition{
		ToStatus: domain.Status(req.ToStatus), ExpectedVersion: req.ExpectedVersion,
		Reason: req.Reason, OperationID: req.OperationID,
	}
	if req.OccurredAt != nil {
		transition.OccurredAt = req.OccurredAt.UTC()
	}
	return transition
}

type interviewRequest struct {
	ID              string     `json:"id"`
	ExpectedVersion *int64     `json:"expectedVersion"`
	RoundNumber     int        `json:"roundNumber"`
	InterviewType   string     `json:"interviewType"`
	ScheduledAt     *time.Time `json:"scheduledAt"`
	Timezone        string     `json:"timezone"`
	DurationMinutes *int       `json:"durationMinutes"`
	LocationOrLink  *string    `json:"locationOrLink"`
	Interviewer     *string    `json:"interviewer"`
	Status          string     `json:"status"`
}

func (req interviewRequest) toDomain() domain.InterviewWrite {
	return domain.InterviewWrite{
		ID: req.ID, ExpectedVersion: req.ExpectedVersion, RoundNumber: req.RoundNumber,
		InterviewType: domain.InterviewType(req.InterviewType),
		ScheduledAt:   normalizeTime(req.ScheduledAt), Timezone: req.Timezone,
		DurationMinutes: req.DurationMinutes, LocationOrLink: req.LocationOrLink,
		Interviewer: req.Interviewer, Status: domain.InterviewStatus(req.Status),
	}
}

type noteRequest struct {
	ID               string  `json:"id"`
	ExpectedVersion  *int64  `json:"expectedVersion"`
	InterviewRoundID *string `json:"interviewRoundId"`
	NoteType         string  `json:"noteType"`
	Content          string  `json:"content"`
}

func (req noteRequest) toDomain() domain.NoteWrite {
	return domain.NoteWrite{
		ID: req.ID, ExpectedVersion: req.ExpectedVersion,
		InterviewRoundID: req.InterviewRoundID, NoteType: domain.NoteType(req.NoteType),
		Content: req.Content,
	}
}

type reminderRequest struct {
	ID               string     `json:"id"`
	ExpectedVersion  *int64     `json:"expectedVersion"`
	ApplicationID    string     `json:"applicationId"`
	InterviewRoundID *string    `json:"interviewRoundId"`
	Title            string     `json:"title"`
	RemindAt         *time.Time `json:"remindAt"`
	Status           string     `json:"status"`
	DeliveredAt      *time.Time `json:"deliveredAt"`
}

func (req reminderRequest) toDomain() domain.ReminderWrite {
	write := domain.ReminderWrite{
		ID: req.ID, ExpectedVersion: req.ExpectedVersion, ApplicationID: req.ApplicationID,
		InterviewRoundID: req.InterviewRoundID, Title: req.Title,
		Status: domain.ReminderStatus(req.Status), DeliveredAt: normalizeTime(req.DeliveredAt),
	}
	if req.RemindAt != nil {
		write.RemindAt = req.RemindAt.UTC()
	}
	return write
}

func normalizeTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	value := t.UTC()
	return &value
}
