package application

import (
	"context"
	"strings"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/security"
)

// IssuedSession is the outcome of a successful authentication.
type IssuedSession struct {
	Token     security.SessionToken
	ExpiresAt time.Time
	User      domain.User
	Device    domain.Device
}

// SessionIssuer registers a device and creates an opaque session for a user.
type SessionIssuer struct {
	devices  DeviceRepository
	sessions SessionRepository
	now      Clock
}

// NewSessionIssuer wires the device and session repositories.
func NewSessionIssuer(
	devices DeviceRepository,
	sessions SessionRepository,
	now Clock,
) *SessionIssuer {
	return &SessionIssuer{devices: devices, sessions: sessions, now: now}
}

// Issue registers the device and creates a session for an authenticated user.
func (s *SessionIssuer) Issue(ctx context.Context, user domain.User, in DeviceInput) (IssuedSession, error) {
	if !user.Status.CanAuthenticate() {
		return IssuedSession{}, domain.ErrUserNotActive
	}
	if !domain.ValidPlatform(in.Platform) {
		return IssuedSession{}, domain.ErrInvalidDeviceInput
	}
	now := s.now()
	device := domain.Device{
		ID:         in.ID,
		UserID:     user.ID,
		Name:       strings.TrimSpace(in.Name),
		Platform:   in.Platform,
		AppVersion: in.AppVersion,
		LastSeenAt: now,
	}
	if err := s.devices.Upsert(ctx, device, now); err != nil {
		return IssuedSession{}, err
	}

	token, err := security.NewSessionToken()
	if err != nil {
		return IssuedSession{}, err
	}
	sessionID, err := id.NewV7()
	if err != nil {
		return IssuedSession{}, err
	}
	session := domain.Session{
		ID:         sessionID.String(),
		UserID:     user.ID,
		DeviceID:   in.ID,
		TokenHash:  token.Hash(),
		ExpiresAt:  now.Add(SessionTTL),
		LastUsedAt: now,
		CreatedAt:  now,
	}
	if err := s.sessions.Create(ctx, session); err != nil {
		return IssuedSession{}, err
	}
	return IssuedSession{Token: token, ExpiresAt: session.ExpiresAt, User: user, Device: device}, nil
}

// Authenticate resolves a live session and its owning user from a raw cookie
// value. It uses a single JOIN and refreshes last_used_at only past a
// configurable threshold to avoid write amplification on hot paths.
func (s *SessionIssuer) Authenticate(ctx context.Context, tokenValue string) (domain.User, domain.Session, error) {
	hash := security.HashSessionValue(tokenValue)
	now := s.now()
	lookup, err := s.sessions.FindLiveByTokenHash(ctx, hash, now)
	if err != nil {
		return domain.User{}, domain.Session{}, err
	}
	user := domain.User{
		ID:     lookup.Session.UserID,
		Status: lookup.UserStatus,
		Email:  lookup.Email,
	}
	if !user.Status.CanAuthenticate() {
		return domain.User{}, domain.Session{}, domain.ErrUserNotActive
	}
	threshold := now.Add(-LastUsedRefreshInterval)
	if lookup.Session.LastUsedAt.Before(threshold) {
		_ = s.sessions.TouchLastUsed(ctx, lookup.Session.ID, now, threshold)
	}
	return user, lookup.Session, nil
}

// Logout revokes the session identified by the raw cookie token value.
func (s *SessionIssuer) Logout(ctx context.Context, tokenValue string) error {
	hash := security.HashSessionValue(tokenValue)
	revoked, err := s.sessions.RevokeByTokenHash(ctx, hash, s.now())
	if err != nil {
		return err
	}
	if !revoked {
		return domain.ErrSessionInvalid
	}
	return nil
}

// RevokeDevice revokes all live sessions belonging to a user-owned device.
// It returns the count of sessions revoked, or ErrDeviceNotFound when the
// device does not belong to the user.
func (s *SessionIssuer) RevokeDevice(ctx context.Context, userID, deviceID string) (int64, error) {
	count, found, err := s.sessions.RevokeDeviceSessions(ctx, userID, deviceID, s.now())
	if err != nil {
		return 0, err
	}
	if !found {
		return 0, domain.ErrDeviceNotFound
	}
	return count, nil
}
