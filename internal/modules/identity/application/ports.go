package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
)

// UserRepository reads identity aggregates required by auth use cases.
type UserRepository interface {
	FindActiveByNormalizedEmail(ctx context.Context, emailNormalized string) (domain.User, error)
	FindByID(ctx context.Context, userID string) (domain.User, error)
}

// CredentialRepository reads development-only password credentials.
type CredentialRepository interface {
	FindPasswordHash(ctx context.Context, userID string) (string, error)
}

// DeviceRepository upserts and reads user-owned devices.
type DeviceRepository interface {
	Upsert(ctx context.Context, device domain.Device, now time.Time) error
	Find(ctx context.Context, userID, deviceID string) (domain.Device, error)
}

// SessionRepository persists opaque sessions and their lifecycle.
type SessionRepository interface {
	Create(ctx context.Context, session domain.Session) error
	FindLiveByTokenHash(ctx context.Context, tokenHash []byte, now time.Time) (domain.Session, error)
	TouchLastUsed(ctx context.Context, sessionID string, now time.Time) error
	RevokeByTokenHash(ctx context.Context, tokenHash []byte, now time.Time) (bool, error)
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
