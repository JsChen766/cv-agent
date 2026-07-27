package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"
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

// ListFilter narrows a JD list query.
type ListFilter struct {
	Limit  int
	Cursor pagination.Key
	HasKey bool
}

// Repository persists job descriptions and their requirements.
type Repository interface {
	Insert(ctx context.Context, tx pgx.Tx, jd domain.JobDescription) error
	FindDetail(ctx context.Context, userID, id string) (domain.JobDescription, error)
	List(ctx context.Context, userID string, filter ListFilter) ([]domain.JobDescription, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.JobDescription, error)
	UpdateAggregate(ctx context.Context, tx pgx.Tx, jd domain.JobDescription) error
	ReplaceRequirements(ctx context.Context, tx pgx.Tx, userID, jdID string, requirements []domain.Requirement) error
	SoftDelete(ctx context.Context, tx pgx.Tx, jd domain.JobDescription) error
	HydrateByIDs(ctx context.Context, userID string, ids []string) (map[string]domain.JobDescription, error)
	BootstrapPage(ctx context.Context, userID, afterID string, limit int) ([]domain.JobDescription, error)
}

// Recorder appends a sync change inside the caller's transaction.
type Recorder interface {
	Record(ctx context.Context, tx pgx.Tx, change SyncChange) error
}

// SyncChange decouples the service from the sync module wire types.
type SyncChange struct {
	UserID        string
	EntityID      string
	EntityVersion int64
	Deleted       bool
	ChangedAt     time.Time
}

// Clock returns the current UTC time.
type Clock func() time.Time

// Service implements the JD use cases.
type Service struct {
	tx       TxRunner
	repo     Repository
	recorder Recorder
	now      Clock
}

// NewService wires the JD service.
func NewService(tx TxRunner, repo Repository, recorder Recorder, now Clock) *Service {
	return &Service{tx: tx, repo: repo, recorder: recorder, now: now}
}

// Get returns one JD with its requirements.
func (s *Service) Get(ctx context.Context, userID, id string) (domain.JobDescription, error) {
	return s.repo.FindDetail(ctx, userID, id)
}

// List returns a cursor page of JDs.
func (s *Service) List(ctx context.Context, userID string, filter ListFilter) ([]domain.JobDescription, error) {
	return s.repo.List(ctx, userID, filter)
}
