package syncadapter

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/experience/application"
	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
)

// Projector hydrates experience projections for the sync feed.
type Projector struct {
	service *application.Service
	repo    application.Repository
}

// NewProjector wires the projector.
func NewProjector(service *application.Service, repo application.Repository) *Projector {
	return &Projector{service: service, repo: repo}
}

// EntityType identifies experiences on the change feed.
func (p *Projector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeExperience
}

// Hydrate loads current projections (including tombstones) for the IDs.
func (p *Projector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	experiences, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(experiences))
	for id, exp := range experiences {
		result[id] = toProjection(exp)
	}
	return result, nil
}

// Bootstrap returns a page of active experience projections ordered by id.
func (p *Projector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	experiences, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(experiences) > limit
	if hasMore {
		experiences = experiences[:limit]
	}
	items := make([]syncmod.Projection, 0, len(experiences))
	for _, exp := range experiences {
		items = append(items, toProjection(exp))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

type revisionPayload struct {
	ID             string  `json:"id"`
	ExperienceID   string  `json:"experienceId"`
	Content        string  `json:"content"`
	Source         string  `json:"source"`
	RevisionHash   *string `json:"revisionHash"`
	RevisionNumber int     `json:"revisionNumber"`
	CreatedAt      string  `json:"createdAt"`
}

type payload struct {
	ID                 string           `json:"id"`
	Category           string           `json:"category"`
	Title              string           `json:"title"`
	Organization       *string          `json:"organization"`
	Role               *string          `json:"role"`
	Location           *string          `json:"location"`
	StartDate          *string          `json:"startDate"`
	EndDate            *string          `json:"endDate"`
	Tags               []string         `json:"tags"`
	ResumeSectionKey   *string          `json:"resumeSectionKey"`
	ResumeSectionLabel *string          `json:"resumeSectionLabel"`
	Status             string           `json:"status"`
	CurrentRevisionID  *string          `json:"currentRevisionId"`
	CurrentRevision    *revisionPayload `json:"currentRevision"`
	CreatedAt          string           `json:"createdAt"`
	UpdatedAt          string           `json:"updatedAt"`
}

func toProjection(exp domain.Experience) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeExperience, EntityID: exp.ID,
		EntityVersion: exp.EntityVersion, UpdatedAt: exp.UpdatedAt,
		DeletedAt: exp.DeletedAt,
	}
	if exp.DeletedAt != nil {
		return projection
	}
	projection.Payload = toPayload(exp)
	return projection
}

func toPayload(exp domain.Experience) payload {
	p := payload{
		ID: exp.ID, Category: string(exp.Category), Title: exp.Title,
		Organization: exp.Organization, Role: exp.Role, Location: exp.Location,
		StartDate: exp.StartDate, EndDate: exp.EndDate, Tags: slice(exp.Tags),
		ResumeSectionKey: exp.ResumeSectionKey, ResumeSectionLabel: exp.ResumeSectionLabel,
		Status: string(exp.Status), CurrentRevisionID: exp.CurrentRevisionID,
		CreatedAt: rfc3339(exp.CreatedAt), UpdatedAt: rfc3339(exp.UpdatedAt),
	}
	if exp.CurrentRevision != nil {
		p.CurrentRevision = toRevisionPayload(*exp.CurrentRevision)
	}
	return p
}

func toRevisionPayload(rev domain.Revision) *revisionPayload {
	var hash *string
	if rev.RevisionHash != "" {
		value := rev.RevisionHash
		hash = &value
	}
	return &revisionPayload{
		ID: rev.ID, ExperienceID: rev.ExperienceID, Content: rev.Content,
		Source: string(rev.Source), RevisionHash: hash,
		RevisionNumber: rev.RevisionNumber, CreatedAt: rfc3339(rev.CreatedAt),
	}
}

func slice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
