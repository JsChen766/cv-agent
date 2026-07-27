package application

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// VersionedID identifies a child tombstone produced by aggregate deletion.
type VersionedID struct {
	ID      string
	Version int64
}

// DeletedChildren groups mutable tracker child tombstones by sync entity type.
type DeletedChildren struct {
	Interviews []VersionedID
	Notes      []VersionedID
	Reminders  []VersionedID
}

// ApplicationCascadeRepository deletes mutable children with the parent.
type ApplicationCascadeRepository interface {
	SoftDeleteChildren(
		ctx context.Context, tx pgx.Tx, userID, appID string,
		deviceID *string, deletedAt time.Time,
	) (DeletedChildren, error)
}

func recordDeletedChildren(
	ctx context.Context, tx pgx.Tx, userID string, deletedAt time.Time,
	recorder Recorder, children []VersionedID,
) error {
	for _, child := range children {
		if err := recorder.Record(ctx, tx, SyncChange{
			UserID: userID, EntityID: child.ID, EntityVersion: child.Version,
			Deleted: true, ChangedAt: deletedAt,
		}); err != nil {
			return err
		}
	}
	return nil
}
