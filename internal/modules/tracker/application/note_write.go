package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

// Replace replaces a note under an optimistic lock in its own transaction.
func (s *NoteService) Replace(
	ctx context.Context, userID, deviceID, appID, noteID string, write domain.NoteWrite,
) (domain.Note, error) {
	if _, err := s.Get(ctx, userID, appID, noteID); err != nil {
		return domain.Note{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Note{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.ReplaceInTx(ctx, tx, userID, deviceID, noteID, write)
	if err != nil {
		return domain.Note{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Note{}, err
	}
	return next, nil
}

// ReplaceInTx replaces a note inside a caller-owned transaction.
func (s *NoteService) ReplaceInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, noteID string, write domain.NoteWrite,
) (domain.Note, error) {
	if err := write.Validate(); err != nil {
		return domain.Note{}, err
	}
	if write.ExpectedVersion == nil {
		return domain.Note{}, domain.ErrInvalidInput
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, noteID)
	if err != nil {
		return domain.Note{}, err
	}
	current.UserID = userID
	if current.EntityVersion != *write.ExpectedVersion {
		return domain.Note{}, domain.ErrVersionConflict
	}
	if err := validateInterviewLink(
		ctx, tx, s.repo, userID, current.ApplicationID, write.InterviewRoundID,
	); err != nil {
		return domain.Note{}, err
	}
	now := s.now()
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.InterviewRoundID = write.InterviewRoundID
	next.NoteType = write.NoteType
	next.Content = write.Content
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Note{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: noteID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.Note{}, err
	}
	return next, nil
}

// Delete soft-deletes a note under an optimistic lock in its own transaction.
func (s *NoteService) Delete(
	ctx context.Context, userID, deviceID, appID, noteID string, expectedVersion int64,
) (domain.Note, error) {
	if _, err := s.Get(ctx, userID, appID, noteID); err != nil {
		return domain.Note{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Note{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, noteID, expectedVersion)
	if err != nil {
		return domain.Note{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Note{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes a note inside a caller-owned transaction.
func (s *NoteService) DeleteInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, noteID string, expectedVersion int64,
) (domain.Note, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, noteID)
	if err != nil {
		return domain.Note{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return domain.Note{}, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.Note{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: noteID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.Note{}, err
	}
	return current, nil
}
