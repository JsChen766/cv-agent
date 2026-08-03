package application

import (
	"context"
	"errors"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
)

// Replace atomically applies the update, bumps entity_version and appends a
// sync_changes upsert row. It rejects mismatched expected versions.
func (s *Service) Replace(
	ctx context.Context,
	userID string,
	deviceID string,
	update domain.Update,
) (domain.Profile, error) {
	if err := update.Validate(); err != nil {
		return domain.Profile{}, err
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Profile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	next, err := s.ReplaceInTx(ctx, tx, userID, deviceID, update)
	if err != nil {
		return domain.Profile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Profile{}, err
	}
	return next, nil
}

// ReplaceInTx applies the same Profile use case inside a caller-owned
// transaction. Sync Push uses it so the business write and operation result
// commit atomically.
func (s *Service) ReplaceInTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	deviceID string,
	update domain.Update,
) (domain.Profile, error) {
	if err := update.Validate(); err != nil {
		return domain.Profile{}, err
	}
	current, err := s.repo.LoadForUpdate(ctx, tx, userID)
	if err != nil {
		return domain.Profile{}, err
	}
	if current.EntityVersion != update.ExpectedVersion {
		return domain.Profile{}, domain.ErrVersionConflict
	}

	next := applyUpdate(current, deviceID, update, s.now())
	if err := s.repo.Replace(ctx, tx, next); err != nil {
		if errors.Is(err, domain.ErrVersionConflict) {
			return domain.Profile{}, domain.ErrVersionConflict
		}
		return domain.Profile{}, err
	}
	if err := s.recorder.Record(ctx, tx, syncmod.Change{
		UserID:        userID,
		EntityType:    syncmod.EntityTypeUserProfile,
		EntityID:      userID,
		EntityVersion: next.EntityVersion,
		Operation:     syncmod.OperationUpsert,
		ChangedAt:     next.UpdatedAt,
	}); err != nil {
		return domain.Profile{}, err
	}
	return next, nil
}

func applyUpdate(
	current domain.Profile,
	deviceID string,
	u domain.Update,
	now time.Time,
) domain.Profile {
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = &deviceID
	next.FullName = u.FullName
	next.ContactEmail = u.ContactEmail
	next.Phone = u.Phone
	next.Location = u.Location
	next.CurrentTitle = u.CurrentTitle
	next.CurrentCompany = u.CurrentCompany
	next.YearsOfExperience = u.YearsOfExperience
	next.CareerStage = u.CareerStage
	next.TargetRoles = normalizeList(u.TargetRoles)
	next.TargetIndustries = normalizeList(u.TargetIndustries)
	next.TargetLocations = normalizeList(u.TargetLocations)
	next.PreferredLanguage = u.PreferredLanguage
	next.ResumeStyle = u.ResumeStyle
	next.LinkedinURL = u.LinkedinURL
	next.GithubURL = u.GithubURL
	next.PersonalWebsite = u.PersonalWebsite
	return next
}

func normalizeList(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
