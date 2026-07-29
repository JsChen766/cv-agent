package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

// Update applies a metadata update under an optimistic lock in its own tx. It
// never changes status.
func (s *ApplicationService) Update(
	ctx context.Context, userID, deviceID, appID string, update domain.Update,
) (domain.Application, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Application{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.UpdateInTx(ctx, tx, userID, deviceID, appID, update)
	if err != nil {
		return domain.Application{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Application{}, err
	}
	return next, nil
}

// UpdateInTx applies a metadata update inside a caller-owned transaction.
func (s *ApplicationService) UpdateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, appID string, update domain.Update,
) (domain.Application, error) {
	if err := update.Validate(); err != nil {
		return domain.Application{}, err
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, appID)
	if err != nil {
		return domain.Application{}, err
	}
	current.UserID = userID
	if current.EntityVersion != update.ExpectedVersion {
		return domain.Application{}, domain.ErrVersionConflict
	}
	jdChanged := !sameOptionalID(current.JdID, update.JdID)
	resumeChanged := !sameOptionalID(current.ResumeID, update.ResumeID)
	jdSnapshot := current.JdTitleSnapshot
	resumeSnapshot := current.ResumeTitleSnapshot
	if jdChanged {
		jdSnapshot, err = resolveTitle(ctx, s.jdTitles, userID, update.JdID)
		if err != nil {
			return domain.Application{}, err
		}
	}
	if resumeChanged {
		resumeSnapshot, err = resolveTitle(ctx, s.resumeTitles, userID, update.ResumeID)
		if err != nil {
			return domain.Application{}, err
		}
		if update.ResumeID != nil && update.ResumeContentHashSnapshot == nil {
			return domain.Application{}, domain.ErrInvalidInput
		}
	}
	now := s.now()
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.JdID = update.JdID
	next.ResumeID = update.ResumeID
	next.JdTitleSnapshot = jdSnapshot
	next.ResumeTitleSnapshot = resumeSnapshot
	if resumeChanged {
		next.ResumeContentHashSnapshot = update.ResumeContentHashSnapshot
	}
	next.CompanyName = update.CompanyName
	next.RoleName = update.RoleName
	next.DeliveryMethod = update.DeliveryMethod
	next.TargetURL = update.TargetURL
	next.AppliedAt = update.AppliedAt
	next.PendingConfirmation = update.PendingConfirmation
	next.CompanyBusiness = update.CompanyBusiness
	next.RoleSummary = update.RoleSummary
	next.CompanyCulture = update.CompanyCulture
	next.RejectionReason = update.RejectionReason
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Application{}, err
	}
	if err := s.appRecorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: appID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.Application{}, err
	}
	return next, nil
}

// Delete soft-deletes an application under an optimistic lock in its own tx.
func (s *ApplicationService) Delete(
	ctx context.Context, userID, deviceID, appID string, expectedVersion int64,
) (domain.Application, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Application{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, appID, expectedVersion)
	if err != nil {
		return domain.Application{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Application{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes an application inside a caller-owned transaction.
func (s *ApplicationService) DeleteInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, appID string, expectedVersion int64,
) (domain.Application, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, appID)
	if err != nil {
		return domain.Application{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return domain.Application{}, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.Application{}, err
	}
	children, err := s.cascade.SoftDeleteChildren(
		ctx, tx, userID, appID, current.LastModifiedDeviceID, now,
	)
	if err != nil {
		return domain.Application{}, err
	}
	if err := s.appRecorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: appID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.Application{}, err
	}
	if err := recordDeletedChildren(
		ctx, tx, userID, now, s.interviewRecorder, children.Interviews,
	); err != nil {
		return domain.Application{}, err
	}
	if err := recordDeletedChildren(ctx, tx, userID, now, s.noteRecorder, children.Notes); err != nil {
		return domain.Application{}, err
	}
	if err := recordDeletedChildren(
		ctx, tx, userID, now, s.reminderRecorder, children.Reminders,
	); err != nil {
		return domain.Application{}, err
	}
	return current, nil
}
