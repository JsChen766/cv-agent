package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// UserRepository reads identity aggregates from PostgreSQL.
type UserRepository struct {
	pool *pgxpool.Pool
}

// NewUserRepository constructs a UserRepository.
func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{pool: pool}
}

const selectActiveUserByEmail = `
SELECT u.id, u.status, e.email_display
FROM users u
JOIN user_emails e ON e.user_id = u.id AND e.is_primary
WHERE e.email_normalized = $1 AND u.status = 'active'`

// FindActiveByNormalizedEmail resolves an active user by primary email.
func (r *UserRepository) FindActiveByNormalizedEmail(ctx context.Context, emailNormalized string) (domain.User, error) {
	var user domain.User
	err := r.pool.QueryRow(ctx, selectActiveUserByEmail, emailNormalized).
		Scan(&user.ID, &user.Status, &user.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, domain.ErrInvalidCredentials
	}
	if err != nil {
		return domain.User{}, err
	}
	return user, nil
}

const selectUserByID = `
SELECT u.id, u.status, COALESCE(e.email_display, '')
FROM users u
LEFT JOIN user_emails e ON e.user_id = u.id AND e.is_primary
WHERE u.id = $1`

// FindByID resolves a user by its identifier.
func (r *UserRepository) FindByID(ctx context.Context, userID string) (domain.User, error) {
	var user domain.User
	err := r.pool.QueryRow(ctx, selectUserByID, userID).
		Scan(&user.ID, &user.Status, &user.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, domain.ErrSessionInvalid
	}
	if err != nil {
		return domain.User{}, err
	}
	return user, nil
}

// CredentialRepository reads development password credentials.
type CredentialRepository struct {
	pool *pgxpool.Pool
}

// NewCredentialRepository constructs a CredentialRepository.
func NewCredentialRepository(pool *pgxpool.Pool) *CredentialRepository {
	return &CredentialRepository{pool: pool}
}

const selectPasswordHash = `
SELECT password_hash FROM development_password_credentials WHERE user_id = $1`

// FindPasswordHash reads the Argon2id PHC string for a user.
func (r *CredentialRepository) FindPasswordHash(ctx context.Context, userID string) (string, error) {
	var hash string
	err := r.pool.QueryRow(ctx, selectPasswordHash, userID).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrInvalidCredentials
	}
	if err != nil {
		return "", err
	}
	return hash, nil
}
