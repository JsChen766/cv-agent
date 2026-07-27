package syncadapter

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// ApplicationProjector hydrates application projections for the sync feed.
type ApplicationProjector struct {
	repo application.ApplicationRepository
}

// NewApplicationProjector wires the projector.
func NewApplicationProjector(repo application.ApplicationRepository) *ApplicationProjector {
	return &ApplicationProjector{repo: repo}
}

// EntityType identifies applications on the change feed.
func (p *ApplicationProjector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeApplication
}

// Hydrate loads current application projections (including tombstones).
func (p *ApplicationProjector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	apps, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(apps))
	for id, app := range apps {
		result[id] = applicationProjection(app)
	}
	return result, nil
}

// Bootstrap returns a page of active application projections ordered by id.
func (p *ApplicationProjector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	apps, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(apps) > limit
	if hasMore {
		apps = apps[:limit]
	}
	items := make([]syncmod.Projection, 0, len(apps))
	for _, app := range apps {
		items = append(items, applicationProjection(app))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

func applicationProjection(a domain.Application) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeApplication, EntityID: a.ID,
		EntityVersion: a.EntityVersion, UpdatedAt: a.UpdatedAt, DeletedAt: a.DeletedAt,
	}
	if a.DeletedAt != nil {
		return projection
	}
	projection.Payload = applicationPayloadOf(a)
	return projection
}
