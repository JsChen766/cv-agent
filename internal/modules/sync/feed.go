package sync

import (
	"context"
	"errors"
	"time"
)

var (
	ErrProjectionMissing = errors.New("sync projection is missing")
	ErrProjectorMissing  = errors.New("sync projector is not registered")
)

// ChangeKey is a lightweight row from sync_changes before entity hydration.
type ChangeKey struct {
	Sequence      int64
	EntityType    EntityType
	EntityID      string
	EntityVersion int64
	Operation     Operation
	ChangedAt     time.Time
}

// Projection is the current cloud representation returned by a module.
type Projection struct {
	EntityType    EntityType
	EntityID      string
	EntityVersion int64
	UpdatedAt     time.Time
	DeletedAt     *time.Time
	Payload       any
}

type ProjectedChange struct {
	EntityType    EntityType
	EntityID      string
	EntityVersion int64
	Operation     Operation
	ChangedAt     time.Time
	Payload       any
}

type Page struct {
	Changes    []ProjectedChange
	NextCursor string
	HasMore    bool
	ServerTime time.Time
}

// ChangeRepository reads the ordered per-user change feed.
type ChangeRepository interface {
	ListAfter(ctx context.Context, userID string, sequence int64, limit int) ([]ChangeKey, error)
	HighWatermark(ctx context.Context, userID string) (int64, error)
}

type BootstrapPage struct {
	Items   []Projection
	HasMore bool
}

// Projector is implemented by each owning business module. Sync never reads
// or writes a business table directly.
type Projector interface {
	EntityType() EntityType
	Hydrate(ctx context.Context, userID string, entityIDs []string) (map[string]Projection, error)
	Bootstrap(ctx context.Context, userID, afterID string, limit int) (BootstrapPage, error)
}

func toProjectedChange(projection Projection) ProjectedChange {
	operation := OperationUpsert
	payload := projection.Payload
	changedAt := projection.UpdatedAt
	if projection.DeletedAt != nil {
		operation = OperationDelete
		changedAt = *projection.DeletedAt
		payload = map[string]any{
			"deletedAt": projection.DeletedAt.UTC().Format(time.RFC3339Nano),
		}
	}
	return ProjectedChange{
		EntityType: projection.EntityType, EntityID: projection.EntityID,
		EntityVersion: projection.EntityVersion, Operation: operation,
		ChangedAt: changedAt, Payload: payload,
	}
}
