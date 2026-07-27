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
	users        UserRepository
	credentials  CredentialRepository
	issuer       *SessionIssuer
	provisioner  Provisioner
	deviceNsSalt string
}

// Provisioner is called after a successful authentication so downstream
// modules (Subscription/Entitlement) can guarantee the caller has an
// active plan before an API response is composed.
type Provisioner interface {
	EnsureDefault(ctx context.Context, userID string) error
}

// NoopProvisioner is used when no ensure-default hook is wired.
type NoopProvisioner struct{}

// EnsureDefault does nothing.
func (NoopProvisioner) EnsureDefault(context.Context, string) error { return nil }

// NewDevLoginService wires the repositories used by development login.
func NewDevLoginService(
	users UserRepository,
	credentials CredentialRepository,
	issuer *SessionIssuer,
	provisioner Provisioner,
	deviceNsSalt string,
) *DevLoginService {
	if provisioner == nil {
		provisioner = NoopProvisioner{}
	}
	return &DevLoginService{
		users:        users,
		credentials:  credentials,
		issuer:       issuer,
		provisioner:  provisioner,
		deviceNsSalt: deviceNsSalt,
	}
}

// DevLoginInput carries the development password login request.
type DevLoginInput struct {
	Email    string
	Password string
	Device   *DeviceInput
	Fallback DeviceFallback
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
		if errors.Is(err, domain.ErrInvalidCredentials) {
			return IssuedSession{}, domain.ErrInvalidCredentials
		}
		return IssuedSession{}, err
	}
	hash, err := s.credentials.FindPasswordHash(ctx, user.ID)
	if err != nil {
		if errors.Is(err, domain.ErrInvalidCredentials) {
			return IssuedSession{}, domain.ErrInvalidCredentials
		}
		return IssuedSession{}, err
	}
	if err := security.VerifyPassword(in.Password, hash); err != nil {
		if errors.Is(err, security.ErrPasswordMismatch) || errors.Is(err, security.ErrInvalidPasswordHash) {
			return IssuedSession{}, domain.ErrInvalidCredentials
		}
		return IssuedSession{}, err
	}
	if err := s.provisioner.EnsureDefault(ctx, user.ID); err != nil {
		return IssuedSession{}, err
	}
	fb := in.Fallback
	if fb.Namespace == "" {
		fb.Namespace = s.deviceNsSalt
	}
	device, err := ResolveDevice(user.ID, in.Device, fb)
	if err != nil {
		return IssuedSession{}, err
	}
	return s.issuer.Issue(ctx, user, device)
}

// NormalizeEmail lowercases and trims an email for stable lookups.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
