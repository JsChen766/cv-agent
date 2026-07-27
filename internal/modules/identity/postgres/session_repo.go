package postgres

import (
	"context"
	"errors"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SessionRepository persists opaque auth sessions.
type SessionRepository struct {
	pool *pgxpool.Pool
}

// NewSessionRepository constructs a SessionRepository.
func NewSessionRepository(pool *pgxpool.Pool) *SessionRepository {
	return &SessionRepository{pool: pool}
}

const insertSession = `
INSERT INTO auth_sessions (
    id, user_id, device_id, token_hash, expires_at, last_used_at, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)`

// Create stores a new session row.
func (r *SessionRepository) Create(ctx context.Context, session domain.Session) error {
	_, err := r.pool.Exec(ctx, insertSession,
		session.ID, session.UserID, session.DeviceID, session.TokenHash,
		session.ExpiresAt, session.LastUsedAt, session.CreatedAt,
	)
	return err
}

const selectLiveSession = `
SELECT s.id, s.user_id, s.device_id, s.expires_at, s.last_used_at, s.revoked_at, s.created_at,
       u.status, COALESCE(e.email_display, '')
FROM auth_sessions s
JOIN users u ON u.id = s.user_id
LEFT JOIN user_emails e ON e.user_id = u.id AND e.is_primary
JOIN devices d ON d.user_id = s.user_id AND d.id = s.device_id
WHERE s.token_hash = $1
  AND s.revoked_at IS NULL
  AND s.expires_at > $2
  AND d.revoked_at IS NULL`

// FindLiveByTokenHash resolves a live session and its owning user in one shot.
func (r *SessionRepository) FindLiveByTokenHash(
	ctx context.Context, tokenHash []byte, now time.Time,
) (application.AuthLookup, error) {
	var lookup application.AuthLookup
	var status string
	err := r.pool.QueryRow(ctx, selectLiveSession, tokenHash, now).Scan(
		&lookup.Session.ID, &lookup.Session.UserID, &lookup.Session.DeviceID,
		&lookup.Session.ExpiresAt, &lookup.Session.LastUsedAt,
		&lookup.Session.RevokedAt, &lookup.Session.CreatedAt,
		&status, &lookup.Email,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.AuthLookup{}, domain.ErrSessionInvalid
	}
	if err != nil {
		return application.AuthLookup{}, err
	}
	lookup.Session.TokenHash = tokenHash
	lookup.UserStatus = domain.UserStatus(status)
	return lookup, nil
}

const touchSession = `
UPDATE auth_sessions SET last_used_at = $2
WHERE id = $1 AND revoked_at IS NULL AND last_used_at < $3`

// TouchLastUsed refreshes last_used_at only when the recorded value is older
// than the supplied threshold, avoiding write amplification on every request.
func (r *SessionRepository) TouchLastUsed(ctx context.Context, sessionID string, now, threshold time.Time) error {
	_, err := r.pool.Exec(ctx, touchSession, sessionID, now, threshold)
	return err
}

const revokeSession = `
UPDATE auth_sessions SET revoked_at = $2
WHERE token_hash = $1 AND revoked_at IS NULL`

// RevokeByTokenHash revokes a live session and reports whether one was affected.
func (r *SessionRepository) RevokeByTokenHash(ctx context.Context, tokenHash []byte, now time.Time) (bool, error) {
	tag, err := r.pool.Exec(ctx, revokeSession, tokenHash, now)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

const revokeDeviceSessions = `
WITH target AS (
    SELECT 1 FROM devices WHERE user_id = $1 AND id = $2
),
revoked AS (
    UPDATE auth_sessions SET revoked_at = $3
    WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM target)
    RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM target), COUNT(*) FROM revoked`

// RevokeDeviceSessions atomically verifies ownership and revokes every live
// session belonging to the device.
func (r *SessionRepository) RevokeDeviceSessions(
	ctx context.Context, userID, deviceID string, now time.Time,
) (int64, bool, error) {
	var found bool
	var count int64
	err := r.pool.QueryRow(ctx, revokeDeviceSessions, userID, deviceID, now).Scan(&found, &count)
	return count, found, err
}
