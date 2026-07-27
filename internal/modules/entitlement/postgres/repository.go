package postgres

import (
	"context"
	"errors"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/entitlement/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository loads entitlement summaries from PostgreSQL.
type Repository struct {
	pool *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

const selectCurrentSubscription = `
SELECT p.code, s.status, s.ends_at
FROM subscriptions s
JOIN plans p ON p.id = s.plan_id
WHERE s.user_id = $1
  AND s.status IN ('trialing', 'active')
  AND s.starts_at <= $2
  AND (s.ends_at IS NULL OR s.ends_at > $2)
  AND p.status = 'active'
ORDER BY s.created_at DESC
LIMIT 1`

const selectPlanFeatures = `
SELECT pe.feature_code, pe.value
FROM plan_entitlements pe
JOIN plans p ON p.id = pe.plan_id
WHERE p.code = $1
ORDER BY pe.feature_code`

// CurrentSummary loads the caller's effective plan and feature values as of
// the supplied wall clock. Entries whose window has closed or whose plan has
// been retired are treated as absent.
func (r *Repository) CurrentSummary(ctx context.Context, userID string, now time.Time) (domain.Summary, error) {
	var summary domain.Summary
	var status string
	err := r.pool.QueryRow(ctx, selectCurrentSubscription, userID, now).
		Scan(&summary.PlanCode, &status, &summary.EffectiveUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Summary{}, domain.ErrNoActiveSubscription
	}
	if err != nil {
		return domain.Summary{}, err
	}
	summary.SubscriptionStatus = domain.SubscriptionStatus(status)

	rows, err := r.pool.Query(ctx, selectPlanFeatures, summary.PlanCode)
	if err != nil {
		return domain.Summary{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var feature domain.Feature
		if err := rows.Scan(&feature.Code, &feature.Value); err != nil {
			return domain.Summary{}, err
		}
		summary.Features = append(summary.Features, feature)
	}
	return summary, rows.Err()
}
