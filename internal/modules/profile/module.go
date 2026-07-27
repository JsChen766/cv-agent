package profile

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/profile/application"
	profilehttp "coolto.local/cv-agent-app-be/internal/modules/profile/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/profile/postgres"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Module bundles the profile module components.
type Module struct {
	Handler *profilehttp.Handler
}

// New assembles the profile module. It reuses the shared sync recorder so
// profile writes append sync_changes rows in the same transaction.
func New(pool *pgxpool.Pool, recorder syncmod.TxRecorder) *Module {
	tx := application.NewPoolTxRunner(pool)
	repo := postgres.NewRepository(pool)
	service := application.NewService(tx, repo, recorder, func() time.Time { return time.Now().UTC() })
	return &Module{Handler: profilehttp.NewHandler(service)}
}
