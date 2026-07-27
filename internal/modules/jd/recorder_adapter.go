package jd

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
)

// recorderAdapter bridges the JD application Recorder port to the shared sync
// TxRecorder without leaking sync wire types into the service.
type recorderAdapter struct {
	recorder syncmod.TxRecorder
}

func (a recorderAdapter) Record(ctx context.Context, tx pgx.Tx, change application.SyncChange) error {
	operation := syncmod.OperationUpsert
	if change.Deleted {
		operation = syncmod.OperationDelete
	}
	return a.recorder.Record(ctx, tx, syncmod.Change{
		UserID:        change.UserID,
		EntityType:    syncmod.EntityTypeJobDescription,
		EntityID:      change.EntityID,
		EntityVersion: change.EntityVersion,
		Operation:     operation,
		ChangedAt:     change.ChangedAt,
	})
}
