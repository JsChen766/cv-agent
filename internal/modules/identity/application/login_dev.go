package application

import (
	"context"
	"errors"
	"strings"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/security"
)

// DevLoginService performs the local/test password login use case.
type DevLoginService struct {
	users       UserRepository
	credentials CredentialRepository
	issuer      *SessionIssuer
}

// NewDevLoginService wires the repositories used by development login.
func NewDevLoginService(
	users UserRepository,
	credentials CredentialRepository,
	issuer *SessionIssuer,
) *DevLoginService {
	return &DevLoginService{users: users, credentials: credentials, issuer: issuer}
}

// DevLoginInput carries the development password login request.
type DevLoginInput struct {
	Email    string
	Password string
	Device   DeviceInput
}

// Login verifies password credentials and issues a session. It never reveals
// whether the failure was a missing account or a wrong password.
func (s *DevLoginService) Login(ctx context.Context, in DevLoginInput) (IssuedSession, error) {
	emailNormalized := NormalizeEmail(in.Email)
	if emailNormalized == "" || in.Password == "" {
		return IssuedSession{}, domain.ErrInvalidCredentials
	}
	user, err := s.users.FindActiveByNormalizedEmail(ctx, emailNormalized)
	if err != nil {
		return IssuedSession{}, domain.ErrInvalidCredentials
	}
	hash, err := s.credentials.FindPasswordHash(ctx, user.ID)
	if err != nil {
		return IssuedSession{}, domain.ErrInvalidCredentials
	}
	if err := security.VerifyPassword(in.Password, hash); err != nil {
		if errors.Is(err, security.ErrPasswordMismatch) || errors.Is(err, security.ErrInvalidPasswordHash) {
			return IssuedSession{}, domain.ErrInvalidCredentials
		}
		return IssuedSession{}, err
	}
	return s.issuer.Issue(ctx, user, in.Device)
}

// NormalizeEmail lowercases and trims an email for stable lookups.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
