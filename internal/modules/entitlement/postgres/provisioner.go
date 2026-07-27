package postgres

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/entitlement/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Provisioner atomically ensures a user has an active default plan
// subscription. It is idempotent: repeated calls with an existing active
// subscription are no-ops and never race across concurrent logins.
type Provisioner struct {
	pool        *pgxpool.Pool
	defaultPlan string
	now         func() time.Time
}

// NewProvisioner wires the shared PostgreSQL pool.
func NewProvisioner(pool *pgxpool.Pool, defaultPlan string) *Provisioner {
	return &Provisioner{
		pool:        pool,
		defaultPlan: defaultPlan,
		now:         func() time.Time { return time.Now().UTC() },
	}
}

const insertDefaultSubscription = `
INSERT INTO subscriptions (
    id, user_id, plan_id, status, starts_at, created_at, updated_at
)
SELECT $1, $2, p.id, 'active', $3, $3, $3
FROM plans p
WHERE p.code = $4 AND p.status = 'active'
ON CONFLICT (user_id) WHERE status IN ('trialing', 'active') DO NOTHING`

const selectEffectiveSubscription = `
SELECT EXISTS (
    SELECT 1
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.user_id = $1
      AND s.status IN ('trialing', 'active')
      AND s.starts_at <= $2
      AND (s.ends_at IS NULL OR s.ends_at > $2)
      AND p.status = 'active'
)`

// EnsureDefault creates a default subscription for a user if none exists.
// The partial unique index subscriptions_one_current_idx enforces the "one
// live subscription per user" invariant even under concurrent inserts.
func (p *Provisioner) EnsureDefault(ctx context.Context, userID string) error {
	sid, err := id.NewV7()
	if err != nil {
		return err
	}
	now := p.now()
	tx, err := p.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, insertDefaultSubscription, sid.String(), userID, now, p.defaultPlan); err != nil {
		return err
	}
	var ensured bool
	if err := tx.QueryRow(ctx, selectEffectiveSubscription, userID, now).Scan(&ensured); err != nil {
		return err
	}
	if !ensured {
		return domain.ErrDefaultSubscriptionUnavailable
	}
	return tx.Commit(ctx)
}
