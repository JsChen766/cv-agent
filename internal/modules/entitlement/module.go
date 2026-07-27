package entitlement

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/entitlement/application"
	entitlementhttp "coolto.local/cv-agent-app-be/internal/modules/entitlement/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/entitlement/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultPlanCode is the plan code used to provision new users. Kept as a
// constant so the identity module can wire the provisioner without importing
// migrations.
const DefaultPlanCode = "development"

// Module bundles the entitlement handler, application service and login-time
// provisioner.
type Module struct {
	Handler     *entitlementhttp.Handler
	Provisioner *postgres.Provisioner
	Service     *application.Service
}

// New assembles the entitlement module from the shared PostgreSQL pool.
func New(pool *pgxpool.Pool) *Module {
	repo := postgres.NewRepository(pool)
	service := application.NewService(repo, func() time.Time { return time.Now().UTC() })
	handler := entitlementhttp.NewHandler(service)
	provisioner := postgres.NewProvisioner(pool, DefaultPlanCode)
	return &Module{Handler: handler, Provisioner: provisioner, Service: service}
}
