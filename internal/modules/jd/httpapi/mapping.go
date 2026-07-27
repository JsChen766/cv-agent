package httpapi

import (
	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"
)

const timeLayout = "2006-01-02T15:04:05Z07:00"

// legacyImportance maps the canonical importance to the deprecated
// low/medium/high scale still consumed by the current APP adapter.
func legacyImportance(importance domain.Importance) string {
	switch importance {
	case domain.ImportanceMustHave:
		return "high"
	case domain.ImportancePreferred:
		return "medium"
	default:
		return "low"
	}
}

// canonicalImportance resolves the DB importance from the request, preferring
// the explicit v2 value and falling back to the legacy scale.
func canonicalImportance(v2 *string, legacy string) domain.Importance {
	if v2 != nil && *v2 != "" {
		return domain.Importance(*v2)
	}
	switch legacy {
	case "high":
		return domain.ImportanceMustHave
	case "medium":
		return domain.ImportancePreferred
	case "low":
		return domain.ImportanceOptional
	default:
		return domain.Importance(legacy)
	}
}

func canonicalCategory(v2 *string, legacy string) domain.RequirementCategory {
	if v2 != nil && *v2 != "" {
		return domain.RequirementCategory(*v2)
	}
	return domain.RequirementCategory(legacy)
}

func toRecordDTO(jd domain.JobDescription) recordDTO {
	dto := recordDTO{
		ID: jd.ID, Title: jd.Title, Company: jd.Company, TargetRole: jd.TargetRole,
		RawText: jd.RawText, Requirements: toRequirementDTOs(jd.Requirements),
		RequirementsOrigin: string(jd.RequirementsOrigin),
		CreatedAt:          jd.CreatedAt.UTC().Format(timeLayout),
		UpdatedAt:          jd.UpdatedAt.UTC().Format(timeLayout),
		SourceKind:         string(jd.SourceKind), SourceURL: jd.SourceURL,
		Status: string(jd.Status), EntityVersion: jd.EntityVersion,
	}
	if jd.JdHash != "" {
		hash := jd.JdHash
		dto.JdHash = &hash
	}
	if jd.DeletedAt != nil {
		deleted := jd.DeletedAt.UTC().Format(timeLayout)
		dto.DeletedAt = &deleted
	}
	return dto
}

func toRequirementDTOs(requirements []domain.Requirement) []requirementDTO {
	items := make([]requirementDTO, 0, len(requirements))
	for _, req := range requirements {
		importance := string(req.Importance)
		category := string(req.Category)
		items = append(items, requirementDTO{
			ID: req.ID, Text: req.Text, Category: category,
			Importance: legacyImportance(req.Importance), Keywords: ensureSlice(req.Keywords),
			Weight: req.Weight, V2Importance: &importance, V2Category: &category,
			SortOrder: req.SortOrder,
		})
	}
	return items
}

func toWrite(req createRequest, expectedVersion int64) domain.Write {
	sourceKind := domain.SourceKind(req.SourceKind)
	if sourceKind == "" {
		sourceKind = domain.SourceManual
	}
	origin := domain.RequirementsOrigin(req.RequirementsOrigin)
	if origin == "" {
		origin = domain.OriginManual
	}
	status := domain.Status(req.Status)
	if status == "" {
		status = domain.StatusActive
	}
	return domain.Write{
		ID: req.ID, ExpectedVersion: expectedVersion, Title: req.Title,
		Company: req.Company, TargetRole: req.TargetRole, SourceKind: sourceKind,
		SourceURL: req.SourceURL, RawText: req.RawText, RequirementsOrigin: origin,
		Status: status, Requirements: toRequirements(req.Requirements),
	}
}

func toRequirements(requests []requirementRequest) []domain.Requirement {
	requirements := make([]domain.Requirement, 0, len(requests))
	for _, req := range requests {
		requirements = append(requirements, domain.Requirement{
			ID: req.ID, Text: req.Text,
			Category:   canonicalCategory(req.V2Category, req.Category),
			Importance: canonicalImportance(req.V2Importance, req.Importance),
			Keywords:   ensureSlice(req.Keywords), Weight: req.Weight,
		})
	}
	return requirements
}

func ensureSlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
