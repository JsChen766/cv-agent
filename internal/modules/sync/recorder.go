package sync

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Change describes a single row appended to sync_changes.
type Change struct {
	UserID        string
	EntityType    EntityType
	EntityID      string
	EntityVersion int64
	Operation     Operation
	ChangedAt     time.Time
}

// TxRecorder appends a sync change inside an active transaction. Business
// modules must call this in the same transaction as the aggregate write.
type TxRecorder interface {
	Record(ctx context.Context, tx pgx.Tx, change Change) error
}

// PgxRecorder is the PostgreSQL adapter for TxRecorder.
type PgxRecorder struct{}

// NewPgxRecorder returns the default TxRecorder.
func NewPgxRecorder() *PgxRecorder {
	return &PgxRecorder{}
}

const insertChange = `
INSERT INTO sync_changes (
    user_id, entity_type, entity_id, entity_version, operation, changed_at
) VALUES ($1, $2, $3, $4, $5, $6)`

// Record appends a change row using the supplied transaction.
func (r *PgxRecorder) Record(ctx context.Context, tx pgx.Tx, c Change) error {
	_, err := tx.Exec(ctx, insertChange,
		c.UserID, string(c.EntityType), c.EntityID, c.EntityVersion,
		string(c.Operation), c.ChangedAt,
	)
	return err
}
