package syncadapter

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

type applicationCreateCommand struct {
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

func (c applicationCreateCommand) toDomain() domain.Create {
	return domain.Create{
		JdID: c.JdID, ResumeID: c.ResumeID, CompanyName: c.CompanyName,
		RoleName: c.RoleName, JdTitleSnapshot: c.JdTitleSnapshot,
		ResumeTitleSnapshot: c.ResumeTitleSnapshot,
		DeliveryMethod:      domain.DeliveryMethod(c.DeliveryMethod), TargetURL: c.TargetURL,
		AppliedAt: utcPtr(c.AppliedAt), PendingConfirmation: c.PendingConfirmation,
		Source: domain.Source(c.Source), DedupeKey: c.DedupeKey,
		CompanyBusiness: c.CompanyBusiness, RoleSummary: c.RoleSummary,
		CompanyCulture: c.CompanyCulture,
	}
}

type applicationUpdateCommand struct {
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

func (c applicationUpdateCommand) toDomain(expectedVersion int64) domain.Update {
	return domain.Update{
		ExpectedVersion: expectedVersion, JdID: c.JdID, ResumeID: c.ResumeID,
		CompanyName: c.CompanyName, RoleName: c.RoleName,
		DeliveryMethod: domain.DeliveryMethod(c.DeliveryMethod), TargetURL: c.TargetURL,
		AppliedAt: utcPtr(c.AppliedAt), PendingConfirmation: c.PendingConfirmation,
		CompanyBusiness: c.CompanyBusiness, RoleSummary: c.RoleSummary,
		CompanyCulture: c.CompanyCulture, RejectionReason: c.RejectionReason,
	}
}

type transitionCommand struct {
	ToStatus   string     `json:"toStatus"`
	OccurredAt *time.Time `json:"occurredAt"`
	Reason     *string    `json:"reason"`
}

func (c transitionCommand) toDomain(expectedVersion int64, operationID string) domain.Transition {
	transition := domain.Transition{
		ToStatus: domain.Status(c.ToStatus), ExpectedVersion: expectedVersion,
		Reason: c.Reason, OperationID: operationID,
	}
	if c.OccurredAt != nil {
		transition.OccurredAt = c.OccurredAt.UTC()
	}
	return transition
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	value := t.UTC()
	return &value
}
