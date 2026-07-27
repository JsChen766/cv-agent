package experience

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/experience/application"
	experiencehttp "coolto.local/cv-agent-app-be/internal/modules/experience/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/experience/postgres"
	"coolto.local/cv-agent-app-be/internal/modules/experience/syncadapter"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Module bundles the experience module components.
type Module struct {
	Handler   *experiencehttp.Handler
	Projector syncmod.Projector
	Commands  syncmod.CommandHandler
}

// New assembles the experience module. It reuses the shared sync recorder so
// experience writes append sync_changes rows in the same transaction.
func New(pool *pgxpool.Pool, recorder syncmod.TxRecorder) *Module {
	tx := application.NewPoolTxRunner(pool)
	repo := postgres.NewRepository(pool)
	service := application.NewService(
		tx, repo, recorderAdapter{recorder}, idempotency.NewStore(),
		func() time.Time { return time.Now().UTC() },
	)
	return &Module{
		Handler:   experiencehttp.NewHandler(service),
		Projector: syncadapter.NewProjector(service, repo),
		Commands:  syncadapter.NewCommandHandler(service),
	}
}
