package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5"
)

func jdHash(rawText string) string {
	sum := sha256.Sum256([]byte(rawText))
	return hex.EncodeToString(sum[:])
}

// Create inserts a JD and its requirements in its own tx.
func (s *Service) Create(
	ctx context.Context, userID, deviceID string, input domain.Write, command idempotency.Command,
) (domain.JobDescription, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.JobDescription{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if input.ID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.JobDescription{}, genErr
		}
		input.ID = generated.String()
	}
	record, err := s.idem.Reserve(ctx, tx, userID, "jd", input.ID, command, s.now())
	if err != nil {
		return domain.JobDescription{}, err
	}
	if record.Replay {
		if err := tx.Commit(ctx); err != nil {
			return domain.JobDescription{}, err
		}
		return s.repo.FindDetail(ctx, userID, record.ResourceID)
	}
	jd, err := s.CreateInTx(ctx, tx, userID, deviceID, input)
	if err != nil {
		return domain.JobDescription{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.JobDescription{}, err
	}
	return jd, nil
}

// CreateInTx inserts a JD and requirements inside a caller-owned transaction and
// appends the sync change. Requirement IDs supplied by the caller are preserved
// for stability; missing IDs are generated.
func (s *Service) CreateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID string, input domain.Write,
) (domain.JobDescription, error) {
	if err := input.ValidateCreate(); err != nil {
		return domain.JobDescription{}, err
	}
	jdID := input.ID
	if jdID == "" {
		generated, err := id.NewV7()
		if err != nil {
			return domain.JobDescription{}, err
		}
		jdID = generated.String()
	}
	now := s.now()
	requirements, err := assignRequirementIDs(input.Requirements, now)
	if err != nil {
		return domain.JobDescription{}, err
	}
	jd := domain.JobDescription{
		ID: jdID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef(deviceID), Title: input.Title,
		Company: input.Company, TargetRole: input.TargetRole, SourceKind: input.SourceKind,
		SourceURL: input.SourceURL, RawText: input.RawText, JdHash: jdHash(input.RawText),
		RequirementsOrigin: input.RequirementsOrigin, Status: input.Status,
		Requirements: requirements,
	}
	if err := s.repo.Insert(ctx, tx, jd); err != nil {
		return domain.JobDescription{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: jdID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.JobDescription{}, err
	}
	return jd, nil
}

func assignRequirementIDs(
	requirements []domain.Requirement, now time.Time,
) ([]domain.Requirement, error) {
	result := make([]domain.Requirement, 0, len(requirements))
	for index, req := range requirements {
		if req.ID == "" {
			generated, err := id.NewV7()
			if err != nil {
				return nil, err
			}
			req.ID = generated.String()
		}
		req.SortOrder = index
		req.CreatedAt = now
		req.UpdatedAt = now
		if req.Keywords == nil {
			req.Keywords = []string{}
		}
		result = append(result, req)
	}
	return result, nil
}

func deviceRef(deviceID string) *string {
	if deviceID == "" {
		return nil
	}
	value := deviceID
	return &value
}
