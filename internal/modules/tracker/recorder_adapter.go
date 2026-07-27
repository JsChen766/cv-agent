package tracker

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"

	"github.com/jackc/pgx/v5"
)

// recorderAdapter bridges the tracker application Recorder port to the shared
// sync TxRecorder. Each instance is bound to one entity type so services stay
// free of sync wire types.
type recorderAdapter struct {
	recorder   syncmod.TxRecorder
	entityType syncmod.EntityType
}

func newRecorder(recorder syncmod.TxRecorder, entityType syncmod.EntityType) recorderAdapter {
	return recorderAdapter{recorder: recorder, entityType: entityType}
}

func (a recorderAdapter) Record(ctx context.Context, tx pgx.Tx, change application.SyncChange) error {
	operation := syncmod.OperationUpsert
	if change.Deleted {
		operation = syncmod.OperationDelete
	}
	return a.recorder.Record(ctx, tx, syncmod.Change{
		UserID:        change.UserID,
		EntityType:    a.entityType,
		EntityID:      change.EntityID,
		EntityVersion: change.EntityVersion,
		Operation:     operation,
		ChangedAt:     change.ChangedAt,
	})
}
