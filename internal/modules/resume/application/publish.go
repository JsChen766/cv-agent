package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"

	"github.com/jackc/pgx/v5"
)

// contentProjection derives a deterministic text projection and its hash from
// the structured document. The backend never renders or runs an LLM; it stores
// a stable projection so contentHash can drive idempotency and conflicts.
func contentProjection(structured json.RawMessage) (string, string) {
	compact := bytes.Buffer{}
	if err := json.Compact(&compact, structured); err != nil {
		compact.Reset()
		compact.Write(structured)
	}
	content := compact.String()
	sum := sha256.Sum256([]byte(content))
	return content, hex.EncodeToString(sum[:])
}

// Publish creates a new resume or replaces an existing one in its own tx and
// reports whether a new document was created.
func (s *Service) Publish(
	ctx context.Context, userID, deviceID string, input domain.Publish,
) (domain.Resume, bool, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Resume{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	resume, created, err := s.PublishInTx(ctx, tx, userID, deviceID, input)
	if err != nil {
		return domain.Resume{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Resume{}, false, err
	}
	return resume, created, nil
}

// PublishInTx creates or replaces a resume inside a caller-owned transaction and
// appends the sync change. When the entity ID already exists it replaces the
// document under an optimistic lock; otherwise it inserts a new document. The
// caller may supply the entity ID for idempotent offline creation.
func (s *Service) PublishInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID string, input domain.Publish,
) (domain.Resume, bool, error) {
	if err := input.Validate(); err != nil {
		return domain.Resume{}, false, err
	}
	if input.ID != "" {
		existing, err := s.repo.LoadForUpdate(ctx, tx, userID, input.ID)
		switch {
		case err == nil:
			existing.UserID = userID
			replaced, replaceErr := s.replaceExisting(ctx, tx, existing, deviceID, input)
			return replaced, false, replaceErr
		case errors.Is(err, domain.ErrNotFound):
		default:
			return domain.Resume{}, false, err
		}
	}
	created, err := s.insertNew(ctx, tx, userID, deviceID, input)
	return created, true, err
}

func (s *Service) insertNew(
	ctx context.Context, tx pgx.Tx, userID, deviceID string, input domain.Publish,
) (domain.Resume, error) {
	resumeID := input.ID
	if resumeID == "" {
		generated, err := id.NewV7()
		if err != nil {
			return domain.Resume{}, err
		}
		resumeID = generated.String()
	}
	now := s.now()
	content, hash := contentProjection(input.Structured)
	resume := domain.Resume{
		ID: resumeID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef(deviceID), Title: input.Title,
		TargetRole: input.TargetRole, TargetCompany: input.TargetCompany, JdID: input.JdID,
		Structured: input.Structured, Content: content, ContentHash: hash,
		SchemaVersion: input.SchemaVersion, Status: input.Status,
		QualityStatus: input.QualityStatus, QualityIssues: input.QualityIssues,
		QualityGateVersion: input.QualityGateVersion, Score: input.Score,
		EvidenceSummary: input.EvidenceSummary, RiskSummary: input.RiskSummary,
		MissingInfo: input.MissingInfo,
	}
	if err := s.repo.Insert(ctx, tx, resume); err != nil {
		return domain.Resume{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: resumeID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.Resume{}, err
	}
	return resume, nil
}

func (s *Service) replaceExisting(
	ctx context.Context, tx pgx.Tx, current domain.Resume, deviceID string, input domain.Publish,
) (domain.Resume, error) {
	if input.ExpectedVersion != nil && current.EntityVersion != *input.ExpectedVersion {
		return domain.Resume{}, domain.ErrVersionConflict
	}
	if input.ExpectedContentHash != nil && current.ContentHash != *input.ExpectedContentHash {
		return domain.Resume{}, domain.ErrContentConflict
	}
	now := s.now()
	content, hash := contentProjection(input.Structured)
	next := current
	next.EntityVersion = current.EntityVersion + 1
	next.UpdatedAt = now
	next.LastModifiedDeviceID = deviceRef(deviceID)
	next.Title = input.Title
	next.TargetRole = input.TargetRole
	next.TargetCompany = input.TargetCompany
	next.JdID = input.JdID
	next.Structured = input.Structured
	next.Content = content
	next.ContentHash = hash
	next.SchemaVersion = input.SchemaVersion
	next.Status = input.Status
	next.QualityStatus = input.QualityStatus
	next.QualityIssues = input.QualityIssues
	next.QualityGateVersion = input.QualityGateVersion
	next.Score = input.Score
	next.EvidenceSummary = input.EvidenceSummary
	next.RiskSummary = input.RiskSummary
	next.MissingInfo = input.MissingInfo
	if err := s.repo.UpdateAggregate(ctx, tx, next); err != nil {
		return domain.Resume{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: current.UserID, EntityID: current.ID, EntityVersion: next.EntityVersion,
		ChangedAt: now,
	}); err != nil {
		return domain.Resume{}, err
	}
	return next, nil
}
