package identity

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	identityemail "coolto.local/cv-agent-app-be/internal/modules/identity/email"
	identityhttp "coolto.local/cv-agent-app-be/internal/modules/identity/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/identity/postgres"
	identityredis "coolto.local/cv-agent-app-be/internal/modules/identity/redis"
	"coolto.local/cv-agent-app-be/internal/platform/config"
	"coolto.local/cv-agent-app-be/internal/platform/httpserver"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	redisv9 "github.com/redis/go-redis/v9"
)

// Options configures how the identity module is mounted.
type Options struct {
	DevPasswordLogin bool
	SecureCookie     bool
	DeviceNSSalt     string
	Provisioner      application.Provisioner
	Entitlements     application.EntitlementReader
	Email            config.Email
	OTP              config.OTP
	Redis            *redisv9.Client
}

// Module bundles the identity application services and HTTP handler.
type Module struct {
	handler          *identityhttp.Handler
	issuer           *application.SessionIssuer
	devPasswordLogin bool
}

// New assembles the identity module from the shared PostgreSQL pool.
func New(pool *pgxpool.Pool, opts Options) *Module {
	now := func() time.Time { return time.Now().UTC() }

	users := postgres.NewUserRepository(pool)
	credentials := postgres.NewCredentialRepository(pool)
	devices := postgres.NewDeviceRepository(pool)
	sessions := postgres.NewSessionRepository(pool)
	challenges := postgres.NewChallengeRepository(pool)

	issuer := application.NewSessionIssuer(devices, sessions, now)
	provisioner := opts.Provisioner
	if provisioner == nil {
		provisioner = application.NoopProvisioner{}
	}
	devLogin := application.NewDevLoginService(users, credentials, issuer, provisioner, opts.DeviceNSSalt)
	var sender application.EmailSender
	if opts.Email.Provider == "brevo" {
		sender = identityemail.NewBrevoSender(
			opts.Email.BrevoAPIBaseURL, opts.Email.BrevoAPIKey,
			opts.Email.BrevoTemplateID,
			opts.Email.BrevoSenderEmail, opts.Email.BrevoSenderName,
			opts.Email.BrevoReplyTo,
		)
	} else {
		sender = identityemail.NewSMTPSender(
			opts.Email.SMTPAddress, opts.Email.SenderEmail, opts.Email.SenderName,
		)
	}
	emailLogin := application.NewEmailLoginService(
		challenges, sender, identityredis.NewRateLimiter(opts.Redis), issuer, provisioner,
		application.EmailLoginConfig{
			HashKey: opts.OTP.HashKey, TTL: opts.OTP.TTL,
			ResendAfter: opts.OTP.ResendAfter, MaxAttempts: opts.OTP.MaxAttempts,
			RateWindow: opts.OTP.RateWindow, EmailSendLimit: opts.OTP.EmailSendLimit,
			DeviceSendLimit: opts.OTP.DeviceSendLimit, IPSendLimit: opts.OTP.IPSendLimit,
			VerifyLimit: opts.OTP.VerifyLimit,
		}, now,
	)

	handler := identityhttp.NewHandler(
		devLogin, emailLogin, issuer, opts.Entitlements, opts.SecureCookie,
	)
	return &Module{handler: handler, issuer: issuer, devPasswordLogin: opts.DevPasswordLogin}
}

// Registrar returns the route registrar mounted under /v1. The identity
// module owns the RequireSession middleware and re-exports it to protect
// its own authenticated endpoints and downstream module routes.
func (m *Module) Registrar() httpserver.RouteRegistrar {
	return func(router chi.Router) {
		m.handler.Routes(router, m.devPasswordLogin, identityhttp.RequireSession(m.issuer))
	}
}

// Authenticator returns the identity module's session authenticator so other
// modules can mount RequireSession middleware without importing internals.
func (m *Module) Authenticator() identityhttp.Authenticator {
	return m.issuer
}
