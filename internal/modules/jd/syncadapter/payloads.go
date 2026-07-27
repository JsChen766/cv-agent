package syncadapter

import "coolto.local/cv-agent-app-be/internal/modules/jd/domain"

type requirementWrite struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Category   string   `json:"category"`
	Importance string   `json:"importance"`
	Keywords   []string `json:"keywords"`
	Weight     *float64 `json:"weight"`
}

type writePayload struct {
	Title              string             `json:"title"`
	Company            *string            `json:"company"`
	TargetRole         *string            `json:"targetRole"`
	SourceKind         string             `json:"sourceKind"`
	SourceURL          *string            `json:"sourceUrl"`
	RawText            string             `json:"rawText"`
	RequirementsOrigin string             `json:"requirementsOrigin"`
	Status             string             `json:"status"`
	Requirements       []requirementWrite `json:"requirements"`
}

func (p writePayload) toDomain(expectedVersion int64) domain.Write {
	sourceKind := domain.SourceKind(p.SourceKind)
	if sourceKind == "" {
		sourceKind = domain.SourceManual
	}
	origin := domain.RequirementsOrigin(p.RequirementsOrigin)
	if origin == "" {
		origin = domain.OriginManual
	}
	status := domain.Status(p.Status)
	if status == "" {
		status = domain.StatusActive
	}
	requirements := make([]domain.Requirement, 0, len(p.Requirements))
	for _, req := range p.Requirements {
		requirements = append(requirements, domain.Requirement{
			ID: req.ID, Text: req.Text, Category: domain.RequirementCategory(req.Category),
			Importance: domain.Importance(req.Importance), Keywords: req.Keywords,
			Weight: req.Weight,
		})
	}
	return domain.Write{
		ExpectedVersion: expectedVersion, Title: p.Title, Company: p.Company,
		TargetRole: p.TargetRole, SourceKind: sourceKind, SourceURL: p.SourceURL,
		RawText: p.RawText, RequirementsOrigin: origin, Status: status,
		Requirements: requirements,
	}
}
