package application

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

// Transition applies a validated status change in its own transaction. The new
// status, the immutable status event, and both sync changes commit atomically.
func (s *ApplicationService) Transition(
	ctx context.Context, userID, deviceID, appID string, input domain.Transition,
) (domain.Application, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Application{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.TransitionInTx(ctx, tx, userID, deviceID, appID, input)
	if err != nil {
		return domain.Application{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Application{}, err
	}
	return next, nil
}

// TransitionInTx locks the application, validates the edge, updates status and
// version, appends the immutable status event, and records both entity changes
// inside a caller-owned transaction. Sync Push reuses it so the operation result
// commits atomically with the state change.
func (s *ApplicationService) TransitionInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, appID string, input domain.Transition,
) (domain.Application, error) {
	if err := input.Validate(); err != nil {
		return domain.Application{}, err
	}
	if err := s.repo.LockOperation(ctx, tx, userID, input.OperationID); err != nil {
		return domain.Application{}, err
	}
	existingEvent, err := s.repo.FindStatusEventByOperation(ctx, tx, userID, input.OperationID)
	switch {
	case err == nil:
		if existingEvent.ApplicationID != appID || existingEvent.ToStatus != input.ToStatus ||
			!sameOptionalText(existingEvent.Reason, input.Reason) {
			return domain.Application{}, domain.ErrOperationReused
		}
		return s.repo.LoadForUpdate(ctx, tx, userID, appID)
	case errors.Is(err, domain.ErrNotFound):
	case err != nil:
		return domain.Application{}, err
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, appID)
	if err != nil {
		return domain.Application{}, err
	}
	current.UserID = userID
	if current.EntityVersion != input.ExpectedVersion {
		return domain.Application{}, domain.ErrVersionConflict
	}
	if !domain.CanTransition(current.Status, input.ToStatus) {
		return domain.Application{}, domain.ErrIllegalTransition
	}
	now := s.now()
	occurredAt := input.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = now
	}
	fromStatus := current.Status
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.Status = input.ToStatus
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Application{}, err
	}

	eventID := input.OperationID
	from := fromStatus
	event := domain.StatusEvent{
		ID: eventID, UserID: userID, ApplicationID: appID,
		FromStatus: &from, ToStatus: input.ToStatus, Reason: input.Reason,
		OccurredAt: occurredAt, CreatedByDevice: deviceRef(deviceID),
		OperationID: eventID, CreatedAt: now,
	}
	if err := s.repo.InsertStatusEvent(ctx, tx, event); err != nil {
		return domain.Application{}, err
	}
	if err := s.appRecorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: appID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.Application{}, err
	}
	if err := s.eventRecorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: eventID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.Application{}, err
	}
	return next, nil
}

func sameOptionalText(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
