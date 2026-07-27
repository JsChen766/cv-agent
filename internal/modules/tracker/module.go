package tracker

import (
	"time"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	trackerhttp "coolto.local/cv-agent-app-be/internal/modules/tracker/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/postgres"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/syncadapter"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Module bundles the tracker module components. Applications and their status
// events, interview rounds, notes and reminders each project onto the sync feed;
// status events are projection-only and never accept a push command.
type Module struct {
	Handler    *trackerhttp.Handler
	Projectors []syncmod.Projector
	Commands   []syncmod.CommandHandler
}

// New assembles the tracker module. It reuses the shared sync recorder so
// tracker writes append sync_changes rows in the same transaction.
func New(
	pool *pgxpool.Pool, recorder syncmod.TxRecorder,
	jdTitles, resumeTitles application.AssetTitleLookup,
) *Module {
	tx := application.NewPoolTxRunner(pool)
	clock := func() time.Time { return time.Now().UTC() }

	appRepo := postgres.NewApplicationRepository(pool)
	interviewRepo := postgres.NewInterviewRepository(pool)
	noteRepo := postgres.NewNoteRepository(pool)
	reminderRepo := postgres.NewReminderRepository(pool)
	idem := idempotency.NewStore()

	appService := application.NewApplicationService(
		tx, appRepo, postgres.NewApplicationCascadeRepository(),
		newRecorder(recorder, syncmod.EntityTypeApplication),
		newRecorder(recorder, syncmod.EntityTypeApplicationStatusEvent),
		newRecorder(recorder, syncmod.EntityTypeInterviewRound),
		newRecorder(recorder, syncmod.EntityTypeApplicationNote),
		newRecorder(recorder, syncmod.EntityTypeReminder),
		jdTitles, resumeTitles,
		idem,
		clock,
	)
	interviewService := application.NewInterviewService(
		tx, interviewRepo, newRecorder(recorder, syncmod.EntityTypeInterviewRound), idem, clock,
	)
	noteService := application.NewNoteService(
		tx, noteRepo, newRecorder(recorder, syncmod.EntityTypeApplicationNote), idem, clock,
	)
	reminderService := application.NewReminderService(
		tx, reminderRepo, newRecorder(recorder, syncmod.EntityTypeReminder), idem, clock,
	)

	handler := trackerhttp.NewHandler(appService, interviewService, noteService, reminderService)
	return &Module{
		Handler: handler,
		Projectors: []syncmod.Projector{
			syncadapter.NewApplicationProjector(appRepo),
			syncadapter.NewStatusEventProjector(appRepo),
			syncadapter.NewInterviewProjector(interviewRepo),
			syncadapter.NewNoteProjector(noteRepo),
			syncadapter.NewReminderProjector(reminderRepo),
		},
		Commands: []syncmod.CommandHandler{
			syncadapter.NewApplicationCommandHandler(appService),
			syncadapter.NewInterviewCommandHandler(interviewService),
			syncadapter.NewNoteCommandHandler(noteService),
			syncadapter.NewReminderCommandHandler(reminderService),
		},
	}
}
