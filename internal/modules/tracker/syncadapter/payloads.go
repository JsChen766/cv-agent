package syncadapter

import "coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

type applicationPayload struct {
	ID                        string  `json:"id"`
	JdID                      *string `json:"jdId"`
	ResumeID                  *string `json:"resumeId"`
	CompanyName               string  `json:"companyName"`
	RoleName                  string  `json:"roleName"`
	JdTitleSnapshot           *string `json:"jdTitleSnapshot"`
	ResumeTitleSnapshot       *string `json:"resumeTitleSnapshot"`
	ResumeContentHashSnapshot *string `json:"resumeContentHashSnapshot"`
	DeliveryMethod            string  `json:"deliveryMethod"`
	TargetURL                 *string `json:"targetUrl"`
	AppliedAt                 *string `json:"appliedAt"`
	Status                    string  `json:"status"`
	PendingConfirmation       bool    `json:"pendingConfirmation"`
	Source                    string  `json:"source"`
	DedupeKey                 *string `json:"dedupeKey"`
	CompanyBusiness           *string `json:"companyBusiness"`
	RoleSummary               *string `json:"roleSummary"`
	CompanyCulture            *string `json:"companyCulture"`
	RejectionReason           *string `json:"rejectionReason"`
	EntityVersion             int64   `json:"entityVersion"`
	CreatedAt                 string  `json:"createdAt"`
	UpdatedAt                 string  `json:"updatedAt"`
}

func applicationPayloadOf(a domain.Application) applicationPayload {
	return applicationPayload{
		ID: a.ID, JdID: a.JdID, ResumeID: a.ResumeID,
		CompanyName: a.CompanyName, RoleName: a.RoleName,
		JdTitleSnapshot: a.JdTitleSnapshot, ResumeTitleSnapshot: a.ResumeTitleSnapshot,
		ResumeContentHashSnapshot: a.ResumeContentHashSnapshot,
		DeliveryMethod:            string(a.DeliveryMethod), TargetURL: a.TargetURL,
		AppliedAt: rfc3339Ptr(a.AppliedAt), Status: string(a.Status),
		PendingConfirmation: a.PendingConfirmation, Source: string(a.Source),
		DedupeKey: a.DedupeKey, CompanyBusiness: a.CompanyBusiness,
		RoleSummary: a.RoleSummary, CompanyCulture: a.CompanyCulture,
		RejectionReason: a.RejectionReason, EntityVersion: a.EntityVersion,
		CreatedAt: rfc3339(a.CreatedAt), UpdatedAt: rfc3339(a.UpdatedAt),
	}
}

type statusEventPayload struct {
	ID            string  `json:"id"`
	ApplicationID string  `json:"applicationId"`
	FromStatus    *string `json:"fromStatus"`
	ToStatus      string  `json:"toStatus"`
	Reason        *string `json:"reason"`
	OccurredAt    string  `json:"occurredAt"`
	OperationID   string  `json:"operationId"`
	CreatedAt     string  `json:"createdAt"`
}

func statusEventPayloadOf(e domain.StatusEvent) statusEventPayload {
	var from *string
	if e.FromStatus != nil {
		value := string(*e.FromStatus)
		from = &value
	}
	return statusEventPayload{
		ID: e.ID, ApplicationID: e.ApplicationID, FromStatus: from,
		ToStatus: string(e.ToStatus), Reason: e.Reason,
		OccurredAt: rfc3339(e.OccurredAt), OperationID: e.OperationID,
		CreatedAt: rfc3339(e.CreatedAt),
	}
}

type interviewPayload struct {
	ID              string  `json:"id"`
	ApplicationID   string  `json:"applicationId"`
	RoundNumber     int     `json:"roundNumber"`
	InterviewType   string  `json:"interviewType"`
	ScheduledAt     *string `json:"scheduledAt"`
	Timezone        string  `json:"timezone"`
	DurationMinutes *int    `json:"durationMinutes"`
	LocationOrLink  *string `json:"locationOrLink"`
	Interviewer     *string `json:"interviewer"`
	Status          string  `json:"status"`
	EntityVersion   int64   `json:"entityVersion"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

func interviewPayloadOf(i domain.InterviewRound) interviewPayload {
	return interviewPayload{
		ID: i.ID, ApplicationID: i.ApplicationID, RoundNumber: i.RoundNumber,
		InterviewType: string(i.InterviewType), ScheduledAt: rfc3339Ptr(i.ScheduledAt),
		Timezone: i.Timezone, DurationMinutes: i.DurationMinutes,
		LocationOrLink: i.LocationOrLink, Interviewer: i.Interviewer,
		Status: string(i.Status), EntityVersion: i.EntityVersion,
		CreatedAt: rfc3339(i.CreatedAt), UpdatedAt: rfc3339(i.UpdatedAt),
	}
}

type notePayload struct {
	ID               string  `json:"id"`
	ApplicationID    string  `json:"applicationId"`
	InterviewRoundID *string `json:"interviewRoundId"`
	NoteType         string  `json:"noteType"`
	Content          string  `json:"content"`
	EntityVersion    int64   `json:"entityVersion"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

func notePayloadOf(n domain.Note) notePayload {
	return notePayload{
		ID: n.ID, ApplicationID: n.ApplicationID, InterviewRoundID: n.InterviewRoundID,
		NoteType: string(n.NoteType), Content: n.Content, EntityVersion: n.EntityVersion,
		CreatedAt: rfc3339(n.CreatedAt), UpdatedAt: rfc3339(n.UpdatedAt),
	}
}

type reminderPayload struct {
	ID               string  `json:"id"`
	ApplicationID    string  `json:"applicationId"`
	InterviewRoundID *string `json:"interviewRoundId"`
	Title            string  `json:"title"`
	RemindAt         string  `json:"remindAt"`
	Status           string  `json:"status"`
	DeliveredAt      *string `json:"deliveredAt"`
	EntityVersion    int64   `json:"entityVersion"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

func reminderPayloadOf(m domain.Reminder) reminderPayload {
	return reminderPayload{
		ID: m.ID, ApplicationID: m.ApplicationID, InterviewRoundID: m.InterviewRoundID,
		Title: m.Title, RemindAt: rfc3339(m.RemindAt), Status: string(m.Status),
		DeliveredAt: rfc3339Ptr(m.DeliveredAt), EntityVersion: m.EntityVersion,
		CreatedAt: rfc3339(m.CreatedAt), UpdatedAt: rfc3339(m.UpdatedAt),
	}
}
