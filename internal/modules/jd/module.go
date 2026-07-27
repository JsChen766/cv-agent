package jd

import (
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	jdhttp "coolto.local/cv-agent-app-be/internal/modules/jd/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/jd/postgres"
	"coolto.local/cv-agent-app-be/internal/modules/jd/syncadapter"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Module bundles the JD module components.
type Module struct {
	Handler   *jdhttp.Handler
	Projector syncmod.Projector
	Commands  syncmod.CommandHandler
	Titles    *application.Service
}

// New assembles the JD module. It reuses the shared sync recorder so JD writes
// append sync_changes rows in the same transaction.
func New(pool *pgxpool.Pool, recorder syncmod.TxRecorder) *Module {
	tx := application.NewPoolTxRunner(pool)
	repo := postgres.NewRepository(pool)
	service := application.NewService(
		tx, repo, recorderAdapter{recorder}, idempotency.NewStore(),
		func() time.Time { return time.Now().UTC() },
	)
	return &Module{
		Handler:   jdhttp.NewHandler(service),
		Projector: syncadapter.NewProjector(repo),
		Commands:  syncadapter.NewCommandHandler(service),
		Titles:    service,
	}
}
