package resume

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/resume/application"
	resumehttp "coolto.local/cv-agent-app-be/internal/modules/resume/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/resume/postgres"
	"coolto.local/cv-agent-app-be/internal/modules/resume/syncadapter"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Module bundles the resume module components.
type Module struct {
	Handler   *resumehttp.Handler
	Projector syncmod.Projector
	Commands  syncmod.CommandHandler
	Titles    *application.Service
}

// New assembles the resume module. It reuses the shared sync recorder so resume
// writes append sync_changes rows in the same transaction.
func New(pool *pgxpool.Pool, recorder syncmod.TxRecorder) *Module {
	tx := application.NewPoolTxRunner(pool)
	repo := postgres.NewRepository(pool)
	service := application.NewService(
		tx, repo, recorderAdapter{recorder}, idempotency.NewStore(),
		func() time.Time { return time.Now().UTC() },
	)
	return &Module{
		Handler:   resumehttp.NewHandler(service),
		Projector: syncadapter.NewProjector(repo),
		Commands:  syncadapter.NewCommandHandler(service),
		Titles:    service,
	}
}
