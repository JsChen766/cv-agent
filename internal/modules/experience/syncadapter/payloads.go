package syncadapter

import "coolto.local/cv-agent-app-be/internal/modules/experience/domain"

type createPayload struct {
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
		Category: domain.Category(p.Category), Title: p.Title, Content: p.Content,
		Organization: p.Organization, Role: p.Role, Location: p.Location,
		StartDate: p.StartDate, EndDate: p.EndDate, Tags: p.Tags,
		Status: status, Source: source,
	}
}

type updatePayload struct {
	Category     *string  `json:"category"`
	Title        *string  `json:"title"`
	Content      *string  `json:"content"`
	Organization *string  `json:"organization"`
	Role         *string  `json:"role"`
	Location     *string  `json:"location"`
	StartDate    *string  `json:"startDate"`
	EndDate      *string  `json:"endDate"`
	Tags         []string `json:"tags"`
	Status       *string  `json:"status"`
	Source       string   `json:"source"`
}

func (p updatePayload) toDomain(expectedVersion int64) domain.Update {
	update := domain.Update{
		ExpectedVersion: expectedVersion, Title: p.Title, Content: p.Content,
		Organization: p.Organization, Role: p.Role, Location: p.Location,
		StartDate: p.StartDate, EndDate: p.EndDate, Tags: p.Tags,
		Source: domain.RevisionSource(p.Source),
	}
	if p.Category != nil {
		category := domain.Category(*p.Category)
		update.Category = &category
	}
	if p.Status != nil {
		status := domain.Status(*p.Status)
		update.Status = &status
	}
	return update
}
