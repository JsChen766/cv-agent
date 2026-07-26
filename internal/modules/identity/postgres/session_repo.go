package postgres

import (
	"context"
	"errors"
	"time"

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
SELECT s.id, s.user_id, s.device_id, s.expires_at, s.last_used_at, s.revoked_at, s.created_at
FROM auth_sessions s
JOIN devices d ON d.user_id = s.user_id AND d.id = s.device_id
WHERE s.token_hash = $1
  AND s.revoked_at IS NULL
  AND s.expires_at > $2
  AND d.revoked_at IS NULL`

// FindLiveByTokenHash resolves a live session whose device is still active.
func (r *SessionRepository) FindLiveByTokenHash(ctx context.Context, tokenHash []byte, now time.Time) (domain.Session, error) {
	var session domain.Session
	err := r.pool.QueryRow(ctx, selectLiveSession, tokenHash, now).Scan(
		&session.ID, &session.UserID, &session.DeviceID,
		&session.ExpiresAt, &session.LastUsedAt, &session.RevokedAt, &session.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Session{}, domain.ErrSessionInvalid
	}
	if err != nil {
		return domain.Session{}, err
	}
	session.TokenHash = tokenHash
	return session, nil
}

const touchSession = `
UPDATE auth_sessions SET last_used_at = $2 WHERE id = $1 AND revoked_at IS NULL`

// TouchLastUsed refreshes the last-used timestamp of a live session.
func (r *SessionRepository) TouchLastUsed(ctx context.Context, sessionID string, now time.Time) error {
	_, err := r.pool.Exec(ctx, touchSession, sessionID, now)
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
