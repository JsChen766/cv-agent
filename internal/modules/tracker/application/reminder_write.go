package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

// Replace replaces a reminder under an optimistic lock in its own transaction.
func (s *ReminderService) Replace(
	ctx context.Context, userID, deviceID, reminderID string, write domain.ReminderWrite,
) (domain.Reminder, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Reminder{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.ReplaceInTx(ctx, tx, userID, deviceID, reminderID, write)
	if err != nil {
		return domain.Reminder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Reminder{}, err
	}
	return next, nil
}

// ReplaceInTx replaces a reminder inside a caller-owned transaction. The
// application association is immutable after creation.
func (s *ReminderService) ReplaceInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, reminderID string, write domain.ReminderWrite,
) (domain.Reminder, error) {
	if err := write.Validate(); err != nil {
		return domain.Reminder{}, err
	}
	if write.ExpectedVersion == nil {
		return domain.Reminder{}, domain.ErrInvalidInput
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, reminderID)
	if err != nil {
		return domain.Reminder{}, err
	}
	current.UserID = userID
	if current.EntityVersion != *write.ExpectedVersion {
		return domain.Reminder{}, domain.ErrVersionConflict
	}
	if err := validateInterviewLink(
		ctx, tx, s.repo, userID, current.ApplicationID, write.InterviewRoundID,
	); err != nil {
		return domain.Reminder{}, err
	}
	now := s.now()
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.InterviewRoundID = write.InterviewRoundID
	next.Title = write.Title
	next.RemindAt = write.RemindAt
	next.Status = write.Status
	next.DeliveredAt = write.DeliveredAt
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Reminder{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: reminderID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.Reminder{}, err
	}
	return next, nil
}

// Delete soft-deletes a reminder under an optimistic lock in its own transaction.
func (s *ReminderService) Delete(
	ctx context.Context, userID, deviceID, reminderID string, expectedVersion int64,
) (domain.Reminder, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Reminder{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, reminderID, expectedVersion)
	if err != nil {
		return domain.Reminder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Reminder{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes a reminder inside a caller-owned transaction.
func (s *ReminderService) DeleteInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, reminderID string, expectedVersion int64,
) (domain.Reminder, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, reminderID)
	if err != nil {
		return domain.Reminder{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return domain.Reminder{}, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.Reminder{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: reminderID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.Reminder{}, err
	}
	return current, nil
}
