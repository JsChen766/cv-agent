package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"
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

// ListFilter narrows an experience search.
type ListFilter struct {
	Query    string
	Category *domain.Category
	Tags     []string
	Status   domain.Status
	Limit    int
	Cursor   pagination.Key
	HasKey   bool
}

// Repository persists experiences and their immutable revisions.
type Repository interface {
	Insert(ctx context.Context, tx pgx.Tx, exp domain.Experience, rev domain.Revision) error
	Exists(ctx context.Context, userID, id string) (bool, error)
	FindDetail(ctx context.Context, userID, id string) (domain.Experience, error)
	List(ctx context.Context, userID string, filter ListFilter) ([]domain.Experience, error)
	ListRevisions(ctx context.Context, userID, expID string, afterNumber, limit int) ([]domain.Revision, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.Experience, error)
	InsertRevision(ctx context.Context, tx pgx.Tx, rev domain.Revision) error
	UpdateAggregate(ctx context.Context, tx pgx.Tx, exp domain.Experience) error
	SoftDelete(ctx context.Context, tx pgx.Tx, exp domain.Experience) error
	HydrateByIDs(ctx context.Context, userID string, ids []string) (map[string]domain.Experience, error)
	BootstrapPage(ctx context.Context, userID, afterID string, limit int) ([]domain.Experience, error)
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

// Service implements the Experience use cases.
type Service struct {
	tx       TxRunner
	repo     Repository
	recorder Recorder
	idem     *idempotency.Store
	now      Clock
}

// NewService wires the experience service.
func NewService(
	tx TxRunner, repo Repository, recorder Recorder, idem *idempotency.Store, now Clock,
) *Service {
	return &Service{tx: tx, repo: repo, recorder: recorder, idem: idem, now: now}
}

// Get returns one experience with its revisions.
func (s *Service) Get(ctx context.Context, userID, id string) (domain.Experience, error) {
	return s.repo.FindDetail(ctx, userID, id)
}

// List returns a cursor page of experience summaries.
func (s *Service) List(ctx context.Context, userID string, filter ListFilter) ([]domain.Experience, error) {
	return s.repo.List(ctx, userID, filter)
}

// ListRevisions returns immutable revisions newest first.
func (s *Service) ListRevisions(
	ctx context.Context, userID, expID string, afterNumber, limit int,
) ([]domain.Revision, error) {
	exists, err := s.repo.Exists(ctx, userID, expID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, domain.ErrNotFound
	}
	return s.repo.ListRevisions(ctx, userID, expID, afterNumber, limit+1)
}
