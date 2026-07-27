package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"

	"github.com/jackc/pgx/v5"
)

// Replace atomically replaces the JD and its complete requirements collection.
func (s *Service) Replace(
	ctx context.Context, userID, deviceID, jdID string, input domain.Write,
) (domain.JobDescription, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.JobDescription{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := s.ReplaceInTx(ctx, tx, userID, deviceID, jdID, input); err != nil {
		return domain.JobDescription{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.JobDescription{}, err
	}
	return s.repo.FindDetail(ctx, userID, jdID)
}

// ReplaceInTx replaces a JD and its requirements inside a caller-owned tx.
func (s *Service) ReplaceInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, jdID string, input domain.Write,
) (domain.JobDescription, error) {
	if err := input.ValidateReplace(); err != nil {
		return domain.JobDescription{}, err
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, jdID)
	if err != nil {
		return domain.JobDescription{}, err
	}
	current.UserID = userID
	if current.EntityVersion != input.ExpectedVersion {
		return domain.JobDescription{}, domain.ErrVersionConflict
	}
	now := s.now()
	requirements, err := assignRequirementIDs(input.Requirements, now)
	if err != nil {
		return domain.JobDescription{}, err
	}
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.Title = input.Title
	next.Company = input.Company
	next.TargetRole = input.TargetRole
	next.SourceKind = input.SourceKind
	next.SourceURL = input.SourceURL
	next.RawText = input.RawText
	next.JdHash = jdHash(input.RawText)
	next.RequirementsOrigin = input.RequirementsOrigin
	next.Status = input.Status
	next.Requirements = requirements

	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.JobDescription{}, err
	}
	if err := s.repo.ReplaceRequirements(ctx, tx, userID, jdID, requirements); err != nil {
		return domain.JobDescription{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: jdID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.JobDescription{}, err
	}
	return next, nil
}

// Delete soft-deletes a JD under an optimistic lock and appends a tombstone.
func (s *Service) Delete(
	ctx context.Context, userID, deviceID, jdID string, expectedVersion int64,
) (domain.JobDescription, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.JobDescription{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, jdID, expectedVersion)
	if err != nil {
		return domain.JobDescription{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.JobDescription{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes a JD inside a caller-owned transaction.
func (s *Service) DeleteInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, jdID string, expectedVersion int64,
) (domain.JobDescription, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, jdID)
	if err != nil {
		return domain.JobDescription{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return domain.JobDescription{}, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.JobDescription{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: jdID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.JobDescription{}, err
	}
	return current, nil
}
