package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TxRunner exposes access to pgx transactions from the application layer
// without leaking pgxpool details into repositories.
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

// BeginTx starts a serializable-safe read-committed transaction.
func (r *PoolTxRunner) BeginTx(ctx context.Context) (pgx.Tx, error) {
	return r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
}

// Repository persists user profiles inside a transaction.
type Repository interface {
	Find(ctx context.Context, userID string) (domain.Profile, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID string) (domain.Profile, error)
	Replace(ctx context.Context, tx pgx.Tx, profile domain.Profile) error
}

// Clock returns the current UTC time.
type Clock func() time.Time

// Service implements the Profile use cases.
type Service struct {
	tx       TxRunner
	repo     Repository
	recorder syncmod.TxRecorder
	now      Clock
}

// NewService wires the profile service.
func NewService(tx TxRunner, repo Repository, recorder syncmod.TxRecorder, now Clock) *Service {
	return &Service{tx: tx, repo: repo, recorder: recorder, now: now}
}

// Get returns the current profile for a user.
func (s *Service) Get(ctx context.Context, userID string) (domain.Profile, error) {
	return s.repo.Find(ctx, userID)
}
