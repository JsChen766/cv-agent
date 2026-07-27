package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
)

// UserRepository reads identity aggregates required by auth use cases.
type UserRepository interface {
	FindActiveByNormalizedEmail(ctx context.Context, emailNormalized string) (domain.User, error)
}

// CredentialRepository reads development-only password credentials.
type CredentialRepository interface {
	FindPasswordHash(ctx context.Context, userID string) (string, error)
}

// DeviceRepository persists user-owned devices required by session issuance.
type DeviceRepository interface {
	Upsert(ctx context.Context, device domain.Device, now time.Time) error
}

// AuthLookup is the infrastructure-independent projection required by the
// authentication hot path.
type AuthLookup struct {
	Session    domain.Session
	UserStatus domain.UserStatus
	Email      string
}

// SessionRepository persists opaque sessions and their lifecycle.
type SessionRepository interface {
	Create(ctx context.Context, session domain.Session) error
	FindLiveByTokenHash(ctx context.Context, tokenHash []byte, now time.Time) (AuthLookup, error)
	TouchLastUsed(ctx context.Context, sessionID string, now, threshold time.Time) error
	RevokeByTokenHash(ctx context.Context, tokenHash []byte, now time.Time) (bool, error)
	RevokeDeviceSessions(
		ctx context.Context, userID, deviceID string, now time.Time,
	) (revoked int64, deviceFound bool, err error)
}

// DeviceInput carries client-supplied device metadata for login flows.
type DeviceInput struct {
	ID         string
	Name       string
	Platform   string
	AppVersion string
}

// Clock abstracts the current time for deterministic use cases.
type Clock func() time.Time

// SessionTTL is the absolute lifetime granted to a new session.
const SessionTTL = 30 * 24 * time.Hour

// LastUsedRefreshInterval is the minimum interval between last_used_at writes.
const LastUsedRefreshInterval = 10 * time.Minute
