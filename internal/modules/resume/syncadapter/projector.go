package syncadapter

import (
	"context"
	"encoding/json"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/resume/application"
	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
)

// Projector hydrates resume projections for the sync feed.
type Projector struct {
	repo application.Repository
}

// NewProjector wires the projector.
func NewProjector(repo application.Repository) *Projector {
	return &Projector{repo: repo}
}

// EntityType identifies resumes on the change feed.
func (p *Projector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeResume
}

// Hydrate loads current projections (including tombstones) for the IDs.
func (p *Projector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	resumes, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(resumes))
	for id, resume := range resumes {
		result[id] = toProjection(resume)
	}
	return result, nil
}

// Bootstrap returns a page of active resume projections ordered by id.
func (p *Projector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	resumes, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(resumes) > limit
	if hasMore {
		resumes = resumes[:limit]
	}
	items := make([]syncmod.Projection, 0, len(resumes))
	for _, resume := range resumes {
		items = append(items, toProjection(resume))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

type payload struct {
	ID                 string          `json:"id"`
	Title              string          `json:"title"`
	TargetRole         *string         `json:"targetRole"`
	TargetCompany      *string         `json:"targetCompany"`
	JdID               *string         `json:"jdId"`
	Structured         json.RawMessage `json:"structured"`
	Content            string          `json:"content"`
	ContentHash        string          `json:"contentHash"`
	SchemaVersion      string          `json:"schemaVersion"`
	Status             string          `json:"status"`
	QualityStatus      string          `json:"qualityStatus"`
	QualityIssues      json.RawMessage `json:"qualityIssues"`
	QualityGateVersion *string         `json:"qualityGateVersion"`
	Score              json.RawMessage `json:"score"`
	EvidenceSummary    json.RawMessage `json:"evidenceSummary"`
	RiskSummary        json.RawMessage `json:"riskSummary"`
	MissingInfo        json.RawMessage `json:"missingInfo"`
	CreatedAt          string          `json:"createdAt"`
	UpdatedAt          string          `json:"updatedAt"`
}

func toProjection(resume domain.Resume) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeResume, EntityID: resume.ID,
		EntityVersion: resume.EntityVersion, UpdatedAt: resume.UpdatedAt,
		DeletedAt: resume.DeletedAt,
	}
	if resume.DeletedAt != nil {
		return projection
	}
	projection.Payload = toPayload(resume)
	return projection
}

func toPayload(resume domain.Resume) payload {
	return payload{
		ID: resume.ID, Title: resume.Title, TargetRole: resume.TargetRole,
		TargetCompany: resume.TargetCompany, JdID: resume.JdID,
		Structured: orEmptyObject(resume.Structured), Content: resume.Content,
		ContentHash: resume.ContentHash, SchemaVersion: resume.SchemaVersion,
		Status: string(resume.Status), QualityStatus: string(resume.QualityStatus),
		QualityIssues: orEmptyArray(resume.QualityIssues), QualityGateVersion: resume.QualityGateVersion,
		Score: orEmptyObject(resume.Score), EvidenceSummary: orEmptyArray(resume.EvidenceSummary),
		RiskSummary: orEmptyArray(resume.RiskSummary), MissingInfo: orEmptyArray(resume.MissingInfo),
		CreatedAt: rfc3339(resume.CreatedAt), UpdatedAt: rfc3339(resume.UpdatedAt),
	}
}

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func orEmptyObject(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

func orEmptyArray(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`[]`)
	}
	return raw
}
