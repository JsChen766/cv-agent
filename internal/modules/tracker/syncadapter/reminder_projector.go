package syncadapter

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// ReminderProjector hydrates reminder projections for the sync feed.
type ReminderProjector struct {
	repo application.ReminderRepository
}

// NewReminderProjector wires the projector.
func NewReminderProjector(repo application.ReminderRepository) *ReminderProjector {
	return &ReminderProjector{repo: repo}
}

// EntityType identifies reminders on the change feed.
func (p *ReminderProjector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeReminder
}

// Hydrate loads current reminder projections (including tombstones).
func (p *ReminderProjector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	reminders, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(reminders))
	for id, reminder := range reminders {
		result[id] = reminderProjection(reminder)
	}
	return result, nil
}

// Bootstrap returns a page of active reminder projections ordered by id.
func (p *ReminderProjector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	reminders, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(reminders) > limit
	if hasMore {
		reminders = reminders[:limit]
	}
	items := make([]syncmod.Projection, 0, len(reminders))
	for _, reminder := range reminders {
		items = append(items, reminderProjection(reminder))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

func reminderProjection(m domain.Reminder) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeReminder, EntityID: m.ID,
		EntityVersion: m.EntityVersion, UpdatedAt: m.UpdatedAt, DeletedAt: m.DeletedAt,
	}
	if m.DeletedAt != nil {
		return projection
	}
	projection.Payload = reminderPayloadOf(m)
	return projection
}
