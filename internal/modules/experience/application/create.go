package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5"
)

func contentHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// Create inserts a new experience and its first revision in its own tx.
func (s *Service) Create(
	ctx context.Context, userID, deviceID string, input domain.Create, command idempotency.Command,
) (domain.Experience, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Experience{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if input.ID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.Experience{}, genErr
		}
		input.ID = generated.String()
	}
	record, err := s.idem.Reserve(
		ctx, tx, userID, "experience", input.ID, command, s.now(),
	)
	if err != nil {
		return domain.Experience{}, err
	}
	if record.Replay {
		if err := tx.Commit(ctx); err != nil {
			return domain.Experience{}, err
		}
		return s.repo.FindDetail(ctx, userID, record.ResourceID)
	}
	exp, err := s.CreateInTx(ctx, tx, userID, deviceID, input)
	if err != nil {
		return domain.Experience{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Experience{}, err
	}
	return exp, nil
}

// CreateInTx inserts a new experience and its first immutable revision inside a
// caller-owned transaction, then appends the sync change. Sync Push reuses it so
// the business write and operation result commit atomically. The caller may
// supply the entity ID for idempotent offline creation.
func (s *Service) CreateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID string, input domain.Create,
) (domain.Experience, error) {
	if err := input.Validate(); err != nil {
		return domain.Experience{}, err
	}
	expID := input.ID
	if expID == "" {
		generated, err := id.NewV7()
		if err != nil {
			return domain.Experience{}, err
		}
		expID = generated.String()
	}
	revID, err := id.NewV7()
	if err != nil {
		return domain.Experience{}, err
	}
	now := s.now()
	deviceRef := deviceRef(deviceID)
	revision := domain.Revision{
		ID: revID.String(), UserID: userID, ExperienceID: expID, RevisionNumber: 1,
		Content: input.Content, Source: input.Source,
		RevisionHash: contentHash(input.Content), CreatedByDevice: deviceRef,
		CreatedAt: now,
	}
	exp := domain.Experience{
		ID: expID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef, Category: input.Category, Title: input.Title,
		Organization: input.Organization, Role: input.Role, Location: input.Location,
		StartDate: input.StartDate, EndDate: input.EndDate,
		Tags: normalizeTags(input.Tags), Status: input.Status,
		CurrentRevisionID: &revision.ID, CurrentRevision: &revision,
	}
	if err := s.repo.Insert(ctx, tx, exp, revision); err != nil {
		return domain.Experience{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: expID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.Experience{}, err
	}
	exp.Revisions = []domain.Revision{revision}
	return exp, nil
}

func deviceRef(deviceID string) *string {
	if deviceID == "" {
		return nil
	}
	value := deviceID
	return &value
}

func normalizeTags(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}
