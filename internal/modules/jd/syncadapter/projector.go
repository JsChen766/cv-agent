package syncadapter

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
)

// Projector hydrates JD projections for the sync feed.
type Projector struct {
	repo application.Repository
}

// NewProjector wires the projector.
func NewProjector(repo application.Repository) *Projector {
	return &Projector{repo: repo}
}

// EntityType identifies JDs on the change feed.
func (p *Projector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeJobDescription
}

// Hydrate loads current projections (including tombstones) for the IDs.
func (p *Projector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	jds, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(jds))
	for id, jd := range jds {
		result[id] = toProjection(jd)
	}
	return result, nil
}

// Bootstrap returns a page of active JD projections ordered by id.
func (p *Projector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	jds, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(jds) > limit
	if hasMore {
		jds = jds[:limit]
	}
	items := make([]syncmod.Projection, 0, len(jds))
	for _, jd := range jds {
		items = append(items, toProjection(jd))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

type requirementPayload struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Category   string   `json:"category"`
	Importance string   `json:"importance"`
	Keywords   []string `json:"keywords"`
	Weight     *float64 `json:"weight"`
	SortOrder  int      `json:"sortOrder"`
}

type payload struct {
	ID                 string               `json:"id"`
	Title              string               `json:"title"`
	Company            *string              `json:"company"`
	TargetRole         *string              `json:"targetRole"`
	SourceKind         string               `json:"sourceKind"`
	SourceURL          *string              `json:"sourceUrl"`
	RawText            string               `json:"rawText"`
	JdHash             string               `json:"jdHash"`
	RequirementsOrigin string               `json:"requirementsOrigin"`
	Status             string               `json:"status"`
	Requirements       []requirementPayload `json:"requirements"`
	CreatedAt          string               `json:"createdAt"`
	UpdatedAt          string               `json:"updatedAt"`
}

func toProjection(jd domain.JobDescription) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeJobDescription, EntityID: jd.ID,
		EntityVersion: jd.EntityVersion, UpdatedAt: jd.UpdatedAt, DeletedAt: jd.DeletedAt,
	}
	if jd.DeletedAt != nil {
		return projection
	}
	projection.Payload = toPayload(jd)
	return projection
}

func toPayload(jd domain.JobDescription) payload {
	requirements := make([]requirementPayload, 0, len(jd.Requirements))
	for _, req := range jd.Requirements {
		requirements = append(requirements, requirementPayload{
			ID: req.ID, Text: req.Text, Category: string(req.Category),
			Importance: string(req.Importance), Keywords: slice(req.Keywords),
			Weight: req.Weight, SortOrder: req.SortOrder,
		})
	}
	return payload{
		ID: jd.ID, Title: jd.Title, Company: jd.Company, TargetRole: jd.TargetRole,
		SourceKind: string(jd.SourceKind), SourceURL: jd.SourceURL, RawText: jd.RawText,
		JdHash: jd.JdHash, RequirementsOrigin: string(jd.RequirementsOrigin),
		Status: string(jd.Status), Requirements: requirements,
		CreatedAt: rfc3339(jd.CreatedAt), UpdatedAt: rfc3339(jd.UpdatedAt),
	}
}

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func slice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
