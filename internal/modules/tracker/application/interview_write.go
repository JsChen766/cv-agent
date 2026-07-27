package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

// Replace replaces an interview round under an optimistic lock in its own tx.
func (s *InterviewService) Replace(
	ctx context.Context, userID, deviceID, appID, roundID string, write domain.InterviewWrite,
) (domain.InterviewRound, error) {
	if _, err := s.Get(ctx, userID, appID, roundID); err != nil {
		return domain.InterviewRound{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.ReplaceInTx(ctx, tx, userID, deviceID, roundID, write)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.InterviewRound{}, err
	}
	return next, nil
}

// ReplaceInTx replaces an interview round inside a caller-owned transaction.
func (s *InterviewService) ReplaceInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, roundID string, write domain.InterviewWrite,
) (domain.InterviewRound, error) {
	if err := write.Validate(); err != nil {
		return domain.InterviewRound{}, err
	}
	if write.ExpectedVersion == nil {
		return domain.InterviewRound{}, domain.ErrInvalidInput
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, roundID)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	current.UserID = userID
	if current.EntityVersion != *write.ExpectedVersion {
		return domain.InterviewRound{}, domain.ErrVersionConflict
	}
	now := s.now()
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.RoundNumber = write.RoundNumber
	next.InterviewType = write.InterviewType
	next.ScheduledAt = write.ScheduledAt
	next.Timezone = write.Timezone
	next.DurationMinutes = write.DurationMinutes
	next.LocationOrLink = write.LocationOrLink
	next.Interviewer = write.Interviewer
	next.Status = write.Status
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.InterviewRound{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: roundID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.InterviewRound{}, err
	}
	return next, nil
}

// Delete soft-deletes an interview round under an optimistic lock in its own tx.
func (s *InterviewService) Delete(
	ctx context.Context, userID, deviceID, appID, roundID string, expectedVersion int64,
) (domain.InterviewRound, error) {
	if _, err := s.Get(ctx, userID, appID, roundID); err != nil {
		return domain.InterviewRound{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, roundID, expectedVersion)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.InterviewRound{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes an interview round inside a caller-owned transaction.
func (s *InterviewService) DeleteInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, roundID string, expectedVersion int64,
) (domain.InterviewRound, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, roundID)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return domain.InterviewRound{}, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.InterviewRound{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: roundID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.InterviewRound{}, err
	}
	return current, nil
}
