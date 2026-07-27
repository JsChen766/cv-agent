package syncadapter

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// InterviewProjector hydrates interview-round projections for the sync feed.
type InterviewProjector struct {
	repo application.InterviewRepository
}

// NewInterviewProjector wires the projector.
func NewInterviewProjector(repo application.InterviewRepository) *InterviewProjector {
	return &InterviewProjector{repo: repo}
}

// EntityType identifies interview rounds on the change feed.
func (p *InterviewProjector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeInterviewRound
}

// Hydrate loads current interview projections (including tombstones).
func (p *InterviewProjector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	rounds, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(rounds))
	for id, round := range rounds {
		result[id] = interviewProjection(round)
	}
	return result, nil
}

// Bootstrap returns a page of active interview projections ordered by id.
func (p *InterviewProjector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	rounds, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(rounds) > limit
	if hasMore {
		rounds = rounds[:limit]
	}
	items := make([]syncmod.Projection, 0, len(rounds))
	for _, round := range rounds {
		items = append(items, interviewProjection(round))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

func interviewProjection(i domain.InterviewRound) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeInterviewRound, EntityID: i.ID,
		EntityVersion: i.EntityVersion, UpdatedAt: i.UpdatedAt, DeletedAt: i.DeletedAt,
	}
	if i.DeletedAt != nil {
		return projection
	}
	projection.Payload = interviewPayloadOf(i)
	return projection
}
