package httpapi

import (
	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
)

const timeLayout = "2006-01-02T15:04:05Z07:00"

const factBankNotApplicable = "not_applicable"

func toRevisionDTO(rev domain.Revision) revisionDTO {
	var hash *string
	if rev.RevisionHash != "" {
		value := rev.RevisionHash
		hash = &value
	}
	return revisionDTO{
		ID: rev.ID, ExperienceID: rev.ExperienceID, Content: rev.Content,
		Source: string(rev.Source), RevisionHash: hash,
		FactBankStatus: factBankNotApplicable,
		CreatedAt:      rev.CreatedAt.UTC().Format(timeLayout),
	}
}

func toSummaryDTO(exp domain.Experience) summaryDTO {
	dto := summaryDTO{
		ID: exp.ID, Category: string(exp.Category), Title: exp.Title,
		Organization: exp.Organization, Role: exp.Role, Location: exp.Location,
		StartDate: exp.StartDate, EndDate: exp.EndDate, Tags: ensureSlice(exp.Tags),
		Status: string(exp.Status), CurrentRevisionID: exp.CurrentRevisionID,
		CreatedAt:     exp.CreatedAt.UTC().Format(timeLayout),
		UpdatedAt:     exp.UpdatedAt.UTC().Format(timeLayout),
		EntityVersion: exp.EntityVersion,
	}
	if exp.CurrentRevision != nil {
		rev := toRevisionDTO(*exp.CurrentRevision)
		dto.CurrentRevision = &rev
	}
	if exp.DeletedAt != nil {
		deleted := exp.DeletedAt.UTC().Format(timeLayout)
		dto.DeletedAt = &deleted
	}
	return dto
}

func toDetailDTO(exp domain.Experience) detailDTO {
	revisions := make([]revisionDTO, 0, len(exp.Revisions))
	for _, rev := range exp.Revisions {
		revisions = append(revisions, toRevisionDTO(rev))
	}
	return detailDTO{summaryDTO: toSummaryDTO(exp), Revisions: revisions}
}

func toCreate(req createRequest) domain.Create {
	source := domain.RevisionSource(req.Source)
	if source == "" {
		source = domain.SourceManual
	}
	status := domain.Status(req.Status)
	if status == "" {
		status = domain.StatusActive
	}
	return domain.Create{
		ID: req.ID, Category: domain.Category(req.Category), Title: req.Title,
		Content: req.Content, Organization: req.Organization, Role: req.Role,
		Location: req.Location, StartDate: req.StartDate, EndDate: req.EndDate,
		Tags: ensureSlice(req.Tags), Status: status, Source: source,
	}
}

func toUpdate(req updateRequest) domain.Update {
	update := domain.Update{
		ExpectedVersion: req.ExpectedVersion, Title: req.Title, Content: req.Content,
		Organization: req.Organization, Role: req.Role, Location: req.Location,
		StartDate: req.StartDate, EndDate: req.EndDate, Tags: req.Tags,
		Source: domain.RevisionSource(req.Source),
	}
	if req.Category != nil {
		category := domain.Category(*req.Category)
		update.Category = &category
	}
	if req.Status != nil {
		status := domain.Status(*req.Status)
		update.Status = &status
	}
	return update
}

func ensureSlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
