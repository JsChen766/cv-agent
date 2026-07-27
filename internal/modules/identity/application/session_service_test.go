package application

import (
	"context"
	"testing"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
)

type sessionRepoSpy struct {
	lookup  AuthLookup
	touches int
}

func (s *sessionRepoSpy) Create(context.Context, domain.Session) error { return nil }

func (s *sessionRepoSpy) FindLiveByTokenHash(
	context.Context, []byte, time.Time,
) (AuthLookup, error) {
	return s.lookup, nil
}

func (s *sessionRepoSpy) TouchLastUsed(
	context.Context, string, time.Time, time.Time,
) error {
	s.touches++
	return nil
}

func (s *sessionRepoSpy) RevokeByTokenHash(
	context.Context, []byte, time.Time,
) (bool, error) {
	return false, nil
}

func (s *sessionRepoSpy) RevokeDeviceSessions(
	context.Context, string, string, time.Time,
) (int64, bool, error) {
	return 0, false, nil
}

func TestAuthenticateSkipsRecentLastUsedWrite(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 27, 1, 0, 0, 0, time.UTC)
	repo := &sessionRepoSpy{lookup: activeLookup(now.Add(-time.Minute))}
	issuer := NewSessionIssuer(nil, repo, func() time.Time { return now })

	if _, _, err := issuer.Authenticate(context.Background(), "token"); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if repo.touches != 0 {
		t.Fatalf("recent session should not be touched, got %d writes", repo.touches)
	}
}

func TestAuthenticateRefreshesStaleLastUsed(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 27, 1, 0, 0, 0, time.UTC)
	repo := &sessionRepoSpy{lookup: activeLookup(now.Add(-LastUsedRefreshInterval - time.Second))}
	issuer := NewSessionIssuer(nil, repo, func() time.Time { return now })

	if _, _, err := issuer.Authenticate(context.Background(), "token"); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if repo.touches != 1 {
		t.Fatalf("stale session should be touched once, got %d writes", repo.touches)
	}
}

func activeLookup(lastUsed time.Time) AuthLookup {
	return AuthLookup{
		Session: domain.Session{
			ID: "session", UserID: "user", DeviceID: "device",
			ExpiresAt: lastUsed.Add(24 * time.Hour), LastUsedAt: lastUsed,
		},
		UserStatus: domain.UserStatusActive,
		Email:      "user@example.com",
	}
}
