package httpapi

import "time"

type applicationDTO struct {
	ID                  string  `json:"id"`
	JdID                *string `json:"jdId"`
	ResumeID            *string `json:"resumeId"`
	CompanyName         string  `json:"companyName"`
	RoleName            string  `json:"roleName"`
	JdTitleSnapshot     *string `json:"jdTitleSnapshot"`
	ResumeTitleSnapshot *string `json:"resumeTitleSnapshot"`
	DeliveryMethod      string  `json:"deliveryMethod"`
	TargetURL           *string `json:"targetUrl"`
	AppliedAt           *string `json:"appliedAt"`
	Status              string  `json:"status"`
	PendingConfirmation bool    `json:"pendingConfirmation"`
	Source              string  `json:"source"`
	DedupeKey           *string `json:"dedupeKey"`
	CompanyBusiness     *string `json:"companyBusiness"`
	RoleSummary         *string `json:"roleSummary"`
	CompanyCulture      *string `json:"companyCulture"`
	RejectionReason     *string `json:"rejectionReason"`
	EntityVersion       int64   `json:"entityVersion"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
	DeletedAt           *string `json:"deletedAt"`
}

type applicationListDTO struct {
	Items      []applicationDTO `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}

type statusEventDTO struct {
	ID            string  `json:"id"`
	ApplicationID string  `json:"applicationId"`
	FromStatus    *string `json:"fromStatus"`
	ToStatus      string  `json:"toStatus"`
	Reason        *string `json:"reason"`
	OccurredAt    string  `json:"occurredAt"`
	OperationID   string  `json:"operationId"`
	CreatedAt     string  `json:"createdAt"`
}

type statusEventListDTO struct {
	Items      []statusEventDTO `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}

type interviewDTO struct {
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
	DeletedAt       *string `json:"deletedAt"`
}

type interviewListDTO struct {
	Items      []interviewDTO `json:"items"`
	NextCursor *string        `json:"nextCursor"`
}

type noteDTO struct {
	ID               string  `json:"id"`
	ApplicationID    string  `json:"applicationId"`
	InterviewRoundID *string `json:"interviewRoundId"`
	NoteType         string  `json:"noteType"`
	Content          string  `json:"content"`
	EntityVersion    int64   `json:"entityVersion"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
	DeletedAt        *string `json:"deletedAt"`
}

type noteListDTO struct {
	Items      []noteDTO `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

type reminderDTO struct {
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
	DeletedAt        *string `json:"deletedAt"`
}

type reminderListDTO struct {
	Items      []reminderDTO `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

func formatTime(t time.Time) string {
	return t.UTC().Format(timeLayout)
}

func formatOptional(t *time.Time) *string {
	if t == nil {
		return nil
	}
	value := t.UTC().Format(timeLayout)
	return &value
}
