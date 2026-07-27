package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"

	"github.com/jackc/pgx/v5"
)

// Patch updates resume metadata under an optimistic lock without replacing the
// structured document, and appends a sync change in one tx.
func (s *Service) Patch(
	ctx context.Context, userID, deviceID, resumeID string, patch domain.MetadataPatch,
) (domain.Resume, error) {
	if err := patch.Validate(); err != nil {
		return domain.Resume{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Resume{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.patchInTx(ctx, tx, userID, deviceID, resumeID, patch)
	if err != nil {
		return domain.Resume{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Resume{}, err
	}
	return next, nil
}

func (s *Service) patchInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, resumeID string, patch domain.MetadataPatch,
) (domain.Resume, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, resumeID)
	if err != nil {
		return domain.Resume{}, err
	}
	current.UserID = userID
	if current.EntityVersion != patch.ExpectedVersion {
		return domain.Resume{}, domain.ErrVersionConflict
	}
	now := s.now()
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	if patch.Title != nil {
		next.Title = *patch.Title
	}
	if patch.Status != nil {
		next.Status = *patch.Status
	}
	if value, set := patch.TargetRole.Get(); set {
		next.TargetRole = value
	}
	if value, set := patch.TargetCompany.Get(); set {
		next.TargetCompany = value
	}
	if value, set := patch.JdID.Get(); set {
		next.JdID = value
	}
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Resume{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: resumeID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.Resume{}, err
	}
	return next, nil
}

// Delete soft-deletes a resume under an optimistic lock and appends a tombstone.
func (s *Service) Delete(
	ctx context.Context, userID, deviceID, resumeID string, expectedVersion int64,
) (domain.Resume, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Resume{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, resumeID, expectedVersion)
	if err != nil {
		return domain.Resume{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Resume{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes a resume inside a caller-owned transaction.
func (s *Service) DeleteInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, resumeID string, expectedVersion int64,
) (domain.Resume, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, resumeID)
	if err != nil {
		return domain.Resume{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return domain.Resume{}, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.Resume{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: resumeID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.Resume{}, err
	}
	return current, nil
}
