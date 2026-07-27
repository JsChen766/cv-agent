package syncadapter

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// NoteProjector hydrates note projections for the sync feed.
type NoteProjector struct {
	repo application.NoteRepository
}

// NewNoteProjector wires the projector.
func NewNoteProjector(repo application.NoteRepository) *NoteProjector {
	return &NoteProjector{repo: repo}
}

// EntityType identifies notes on the change feed.
func (p *NoteProjector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeApplicationNote
}

// Hydrate loads current note projections (including tombstones).
func (p *NoteProjector) Hydrate(
	ctx context.Context, userID string, entityIDs []string,
) (map[string]syncmod.Projection, error) {
	notes, err := p.repo.HydrateByIDs(ctx, userID, entityIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]syncmod.Projection, len(notes))
	for id, note := range notes {
		result[id] = noteProjection(note)
	}
	return result, nil
}

// Bootstrap returns a page of active note projections ordered by id.
func (p *NoteProjector) Bootstrap(
	ctx context.Context, userID, afterID string, limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	notes, err := p.repo.BootstrapPage(ctx, userID, afterID, limit+1)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	hasMore := len(notes) > limit
	if hasMore {
		notes = notes[:limit]
	}
	items := make([]syncmod.Projection, 0, len(notes))
	for _, note := range notes {
		items = append(items, noteProjection(note))
	}
	return syncmod.BootstrapPage{Items: items, HasMore: hasMore}, nil
}

func noteProjection(n domain.Note) syncmod.Projection {
	projection := syncmod.Projection{
		EntityType: syncmod.EntityTypeApplicationNote, EntityID: n.ID,
		EntityVersion: n.EntityVersion, UpdatedAt: n.UpdatedAt, DeletedAt: n.DeletedAt,
	}
	if n.DeletedAt != nil {
		return projection
	}
	projection.Payload = notePayloadOf(n)
	return projection
}
