package syncadapter

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// StatusEventProjector hydrates immutable status-event projections. Events are
// never updated or deleted, so no tombstone path exists and there is no command
// handler; they are produced only by application transitions.
type StatusEventProjector struct {
	repo application.ApplicationRepository
}

// NewStatusEventProjector wires the projector.
func NewStatusEventProjector(repo application.ApplicationRepository) *StatusEventProjector {
	return &StatusEventProjector{repo: repo}
}

// EntityType identifies status events on the change feed.
func (p *StatusEventProjector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeApplicationStatusEvent
}

// Hydrate loads current status-event projections.
func (p *StatusEventProjector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	events, err := p.repo.HydrateStatusEvents(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(events))
	for id, event := range events {
		result[id] = statusEventProjection(event)
	}
	return result, nil
}

// Bootstrap returns a page of status-event projections ordered by id.
func (p *StatusEventProjector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	events, err := p.repo.BootstrapEvents(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	items := make([]syncmod.Projection, 0, len(events))
	for _, event := range events {
		items = append(items, statusEventProjection(event))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

func statusEventProjection(e domain.StatusEvent) syncmod.Projection {
	return syncmod.Projection{
		EntityType: syncmod.EntityTypeApplicationStatusEvent, EntityID: e.ID,
		EntityVersion: 1, UpdatedAt: e.CreatedAt, Payload: statusEventPayloadOf(e),
	}
}
