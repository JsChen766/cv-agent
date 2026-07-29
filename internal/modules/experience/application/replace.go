package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"

	"github.com/jackc/pgx/v5"
)

// Replace applies an update under an optimistic lock. When content changes it
// appends a new immutable revision and atomically switches the current
// revision. It bumps entity_version and appends a sync change in one tx.
func (s *Service) Replace(
	ctx context.Context,
	userID string,
	deviceID string,
	id string,
	update domain.Update,
) (domain.Experience, error) {
	if err := update.Validate(); err != nil {
		return domain.Experience{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Experience{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := s.ReplaceInTx(ctx, tx, userID, deviceID, id, update); err != nil {
		return domain.Experience{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Experience{}, err
	}
	return s.repo.FindDetail(ctx, userID, id)
}

// ReplaceInTx applies the update inside a caller-owned transaction and returns
// the new aggregate state (with its current revision) without re-reading.
func (s *Service) ReplaceInTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	deviceID string,
	expID string,
	update domain.Update,
) (domain.Experience, error) {
	if err := update.Validate(); err != nil {
		return domain.Experience{}, err
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, expID)
	if err != nil {
		return domain.Experience{}, err
	}
	current.UserID = userID
	if current.EntityVersion != update.ExpectedVersion {
		return current, domain.ErrVersionConflict
	}
	if current.DeletedAt != nil {
		return current, domain.ErrVersionConflict
	}
	now := s.now()
	next := applyUpdate(current, deviceRef(deviceID), update, now)

	if err := s.maybeAppendRevision(ctx, tx, &next, current, deviceID, update); err != nil {
		return domain.Experience{}, err
	}
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Experience{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: expID, EntityVersion: next.EntityVersion, ChangedAt: now,
	}); err != nil {
		return domain.Experience{}, err
	}
	return next, nil
}

func (s *Service) maybeAppendRevision(
	ctx context.Context,
	tx pgx.Tx,
	next *domain.Experience,
	current domain.Experience,
	deviceID string,
	update domain.Update,
) error {
	newHash := contentHash(update.Content)
	if current.CurrentRevision != nil && current.CurrentRevision.RevisionHash == newHash {
		return nil
	}
	revisionID := update.RevisionID
	if revisionID == "" {
		revID, err := id.NewV7()
		if err != nil {
			return err
		}
		revisionID = revID.String()
	} else if !id.Valid(revisionID) {
		return domain.ErrInvalidInput
	}
	source := update.Source
	if source == "" {
		source = domain.SourceManual
	}
	number := 1
	if current.CurrentRevision != nil {
		number = current.CurrentRevision.RevisionNumber + 1
	}
	revision := domain.Revision{
		ID: revisionID, UserID: current.UserID, ExperienceID: current.ID, RevisionNumber: number,
		Content: update.Content, Source: source, RevisionHash: newHash,
		CreatedByDevice: deviceRef(deviceID), CreatedAt: s.now(),
	}
	if err := s.repo.InsertRevision(ctx, tx, revision); err != nil {
		return err
	}
	next.CurrentRevisionID = &revision.ID
	next.CurrentRevision = &revision
	return nil
}

func applyUpdate(
	current domain.Experience,
	deviceRef *string,
	u domain.Update,
	now time.Time,
) domain.Experience {
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef
	next.Category = u.Category
	next.Title = u.Title
	next.Status = u.Status
	next.Organization = u.Organization
	next.Role = u.Role
	next.Location = u.Location
	next.StartDate = u.StartDate
	next.EndDate = u.EndDate
	next.Tags = normalizeTags(u.Tags)
	return next
}

// Delete soft-deletes an experience under an optimistic lock and appends a
// tombstone sync change.
func (s *Service) Delete(
	ctx context.Context,
	userID string,
	deviceID string,
	expID string,
	expectedVersion int64,
) (domain.Experience, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Experience{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deleted, err := s.DeleteInTx(ctx, tx, userID, deviceID, expID, expectedVersion)
	if err != nil {
		return domain.Experience{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Experience{}, err
	}
	return deleted, nil
}

// DeleteInTx soft-deletes an experience inside a caller-owned transaction.
func (s *Service) DeleteInTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	deviceID string,
	expID string,
	expectedVersion int64,
) (domain.Experience, error) {
	current, err := s.repo.LoadForUpdate(ctx, tx, userID, expID)
	if err != nil {
		return domain.Experience{}, err
	}
	current.UserID = userID
	if current.EntityVersion != expectedVersion {
		return current, domain.ErrVersionConflict
	}
	if current.DeletedAt != nil {
		return current, domain.ErrVersionConflict
	}
	now := s.now()
	current.EntityVersion++
	current.DeletedAt = &now
	current.LastModifiedDeviceID = deviceRef(deviceID)
	if err := s.repo.SoftDelete(ctx, tx, current); err != nil {
		return domain.Experience{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: expID, EntityVersion: current.EntityVersion,
		Deleted: true, ChangedAt: now,
	}); err != nil {
		return domain.Experience{}, err
	}
	return current, nil
}
