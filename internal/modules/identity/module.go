package identity

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	identityhttp "coolto.local/cv-agent-app-be/internal/modules/identity/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/identity/postgres"
	"coolto.local/cv-agent-app-be/internal/platform/httpserver"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Options configures how the identity module is mounted.
type Options struct {
	DevPasswordLogin bool
	SecureCookie     bool
}

// Module bundles the identity application services and HTTP handler.
type Module struct {
	handler          *identityhttp.Handler
	devPasswordLogin bool
}

// New assembles the identity module from the shared PostgreSQL pool.
func New(pool *pgxpool.Pool, opts Options) *Module {
	now := func() time.Time { return time.Now().UTC() }

	users := postgres.NewUserRepository(pool)
	credentials := postgres.NewCredentialRepository(pool)
	devices := postgres.NewDeviceRepository(pool)
	sessions := postgres.NewSessionRepository(pool)

	issuer := application.NewSessionIssuer(users, devices, sessions, now)
	devLogin := application.NewDevLoginService(users, credentials, issuer)

	handler := identityhttp.NewHandler(devLogin, issuer, opts.SecureCookie)
	return &Module{handler: handler, devPasswordLogin: opts.DevPasswordLogin}
}

// Registrar returns the route registrar mounted under /v1.
func (m *Module) Registrar() httpserver.RouteRegistrar {
	return func(router chi.Router) {
		m.handler.Routes(router, m.devPasswordLogin)
	}
}
