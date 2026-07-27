package postgres

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ChallengeRepository owns PostgreSQL challenge truth and account creation.
type ChallengeRepository struct{ pool *pgxpool.Pool }

func NewChallengeRepository(pool *pgxpool.Pool) *ChallengeRepository {
	return &ChallengeRepository{pool: pool}
}

const insertChallenge = `
INSERT INTO email_login_challenges (
    id, email_normalized, purpose, code_hash, delivery_status,
    max_attempts, expires_at, request_ip_hash, device_fingerprint_hash, created_at
) VALUES ($1, $2, 'login', $3, 'pending', $4, $5, $6, $7, $8)`

func (r *ChallengeRepository) Create(ctx context.Context, c domain.EmailChallenge) error {
	_, err := r.pool.Exec(ctx, insertChallenge, c.ID, c.EmailNormalized, c.CodeHash,
		c.MaxAttempts, c.ExpiresAt, c.RequestIPHash, c.DeviceFingerprintHash, c.CreatedAt)
	return err
}

func (r *ChallengeRepository) MarkDelivery(ctx context.Context, challengeID, status string) error {
	if status != "sent" && status != "failed" {
		return errors.New("invalid challenge delivery status")
	}
	_, err := r.pool.Exec(ctx, `
UPDATE email_login_challenges SET delivery_status = $2
WHERE id = $1 AND delivery_status = 'pending'`, challengeID, status)
	return err
}

type challengeRow struct {
	email, status string
	hash          []byte
	attempts, max int
	expires       time.Time
	consumed      *time.Time
}

func (r *ChallengeRepository) VerifyAndResolveUser(
	ctx context.Context, challengeID string, codeHash []byte, now time.Time,
) (domain.User, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row, err := loadChallenge(ctx, tx, challengeID)
	if err != nil {
		return domain.User{}, err
	}
	if row.status != "sent" || row.consumed != nil {
		return domain.User{}, domain.ErrChallengeInvalid
	}
	if !now.Before(row.expires) {
		return domain.User{}, domain.ErrChallengeExpired
	}
	if row.attempts >= row.max {
		return domain.User{}, domain.ErrChallengeAttempts
	}
	if subtle.ConstantTimeCompare(row.hash, codeHash) != 1 {
		row.attempts++
		if _, err := tx.Exec(ctx, `UPDATE email_login_challenges
SET attempt_count = $2 WHERE id = $1`, challengeID, row.attempts); err != nil {
			return domain.User{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return domain.User{}, err
		}
		if row.attempts >= row.max {
			return domain.User{}, domain.ErrChallengeAttempts
		}
		return domain.User{}, domain.ErrChallengeInvalid
	}

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, row.email); err != nil {
		return domain.User{}, err
	}
	user, err := resolveOrCreateUser(ctx, tx, row.email, now)
	if err != nil {
		return domain.User{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE email_login_challenges
SET consumed_at = $2 WHERE id = $1`, challengeID, now); err != nil {
		return domain.User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func loadChallenge(ctx context.Context, tx pgx.Tx, id string) (challengeRow, error) {
	var row challengeRow
	err := tx.QueryRow(ctx, `
SELECT email_normalized, code_hash, delivery_status, attempt_count,
       max_attempts, expires_at, consumed_at
FROM email_login_challenges WHERE id = $1 FOR UPDATE`, id).Scan(
		&row.email, &row.hash, &row.status, &row.attempts,
		&row.max, &row.expires, &row.consumed,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, domain.ErrChallengeInvalid
	}
	return row, err
}

func resolveOrCreateUser(
	ctx context.Context, tx pgx.Tx, email string, now time.Time,
) (domain.User, error) {
	var user domain.User
	var status string
	err := tx.QueryRow(ctx, `
SELECT u.id, u.status, e.email_display FROM users u
JOIN user_emails e ON e.user_id = u.id AND e.is_primary
WHERE e.email_normalized = $1`, email).Scan(&user.ID, &status, &user.Email)
	if err == nil {
		user.Status = domain.UserStatus(status)
		if !user.Status.CanAuthenticate() {
			return domain.User{}, domain.ErrUserNotActive
		}
		return user, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, err
	}
	uid, err := id.NewV7()
	if err != nil {
		return domain.User{}, err
	}
	user = domain.User{ID: uid.String(), Status: domain.UserStatusActive, Email: email}
	if _, err = tx.Exec(ctx, `INSERT INTO users
(id, status, created_at, updated_at) VALUES ($1, 'active', $2, $2)`, user.ID, now); err != nil {
		return domain.User{}, err
	}
	eid, err := id.NewV7()
	if err != nil {
		return domain.User{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_emails
(id, user_id, email_normalized, email_display, verified_at, created_at)
VALUES ($1, $2, $3, $3, $4, $4)`, eid.String(), user.ID, email, now); err != nil {
		return domain.User{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO user_profiles
(id, user_id, created_at, updated_at) VALUES ($1, $1, $2, $2)`, user.ID, now)
	return user, err
}
