package syncadapter

import "coolto.local/cv-agent-app-be/internal/modules/experience/domain"

type createPayload struct {
	RevisionID   string   `json:"revisionId"`
	Category     string   `json:"category"`
	Title        string   `json:"title"`
	Content      string   `json:"content"`
	Organization *string  `json:"organization"`
	Role         *string  `json:"role"`
	Location     *string  `json:"location"`
	StartDate    *string  `json:"startDate"`
	EndDate      *string  `json:"endDate"`
	Tags         []string `json:"tags"`
	Status       string   `json:"status"`
	Source       string   `json:"source"`
}

func (p createPayload) toDomain() domain.Create {
	source := domain.RevisionSource(p.Source)
	if source == "" {
		source = domain.SourceManual
	}
	status := domain.Status(p.Status)
	if status == "" {
		status = domain.StatusActive
	}
	return domain.Create{
		RevisionID: p.RevisionID,
		Category:   domain.Category(p.Category), Title: p.Title, Content: p.Content,
		Organization: p.Organization, Role: p.Role, Location: p.Location,
		StartDate: p.StartDate, EndDate: p.EndDate, Tags: p.Tags,
		Status: status, Source: source,
	}
}

type updatePayload struct {
	RevisionID   string   `json:"revisionId"`
	Category     string   `json:"category"`
	Title        string   `json:"title"`
	Content      string   `json:"content"`
	Organization *string  `json:"organization"`
	Role         *string  `json:"role"`
	Location     *string  `json:"location"`
	StartDate    *string  `json:"startDate"`
	EndDate      *string  `json:"endDate"`
	Tags         []string `json:"tags"`
	Status       string   `json:"status"`
	Source       string   `json:"source"`
}

func (p updatePayload) toDomain(expectedVersion int64) domain.Update {
	return domain.Update{
		ExpectedVersion: expectedVersion, RevisionID: p.RevisionID,
		Category: domain.Category(p.Category), Title: p.Title, Content: p.Content,
		Organization: p.Organization, Role: p.Role, Location: p.Location,
		StartDate: p.StartDate, EndDate: p.EndDate, Tags: p.Tags,
		Status: domain.Status(p.Status), Source: domain.RevisionSource(p.Source),
	}
}
