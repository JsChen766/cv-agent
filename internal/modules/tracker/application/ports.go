package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TxRunner exposes pgx transactions to the application layer.
type TxRunner interface {
	BeginTx(ctx context.Context) (pgx.Tx, error)
}

// PoolTxRunner adapts a pgxpool.Pool to TxRunner.
type PoolTxRunner struct {
	pool *pgxpool.Pool
}

// NewPoolTxRunner constructs a PoolTxRunner.
func NewPoolTxRunner(pool *pgxpool.Pool) *PoolTxRunner {
	return &PoolTxRunner{pool: pool}
}

// BeginTx starts a read-committed transaction.
func (r *PoolTxRunner) BeginTx(ctx context.Context) (pgx.Tx, error) {
	return r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
}

// Clock returns the current UTC time.
type Clock func() time.Time

// SyncChange decouples services from the sync module wire types. Each service
// owns a Recorder bound to its entity type, so the type is not carried here.
type SyncChange struct {
	UserID        string
	EntityID      string
	EntityVersion int64
	Deleted       bool
	ChangedAt     time.Time
}

// Recorder appends a sync change inside the caller's transaction.
type Recorder interface {
	Record(ctx context.Context, tx pgx.Tx, change SyncChange) error
}

// ApplicationFilter narrows the tracker board query.
type ApplicationFilter struct {
	Status              *domain.Status
	Company             string
	JdID                *string
	ResumeID            *string
	PendingConfirmation *bool
	Limit               int
	Cursor              pagination.Key
	HasKey              bool
}

// ChildFilter narrows a child list query scoped to one application.
type ChildFilter struct {
	Limit  int
	Cursor pagination.Key
	HasKey bool
}

// ReminderFilter narrows a reminder list query.
type ReminderFilter struct {
	ApplicationID *string
	Status        *domain.ReminderStatus
	Limit         int
	Cursor        pagination.Key
	HasKey        bool
}

func deviceRef(deviceID string) *string {
	if deviceID == "" {
		return nil
	}
	value := deviceID
	return &value
}
