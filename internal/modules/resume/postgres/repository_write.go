package postgres

import (
	"context"
	"errors"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const insertResume = `
INSERT INTO resumes (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    title, target_role, target_company, jd_id, structured, content, content_hash,
    schema_version, status, quality_status, quality_issues, quality_gate_version,
    score, evidence_summary, risk_summary, missing_info
) VALUES (
    $1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
    $17, $18, $19, $20, $21
)`

// Insert writes a new resume.
func (r *Repository) Insert(ctx context.Context, tx pgx.Tx, resume domain.Resume) error {
	_, err := tx.Exec(ctx, insertResume,
		resume.ID, resume.UserID, resume.EntityVersion, resume.CreatedAt,
		resume.LastModifiedDeviceID, resume.Title, resume.TargetRole, resume.TargetCompany,
		resume.JdID, resume.Structured, resume.Content, resume.ContentHash,
		resume.SchemaVersion, string(resume.Status), string(resume.QualityStatus),
		resume.QualityIssues, resume.QualityGateVersion, resume.Score,
		resume.EvidenceSummary, resume.RiskSummary, resume.MissingInfo,
	)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return domain.ErrDuplicate
	}
	return err
}

// LoadForUpdate loads a resume with a row lock.
func (r *Repository) LoadForUpdate(
	ctx context.Context, tx pgx.Tx, userID, id string,
) (domain.Resume, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+fullColumns+" FROM resumes r WHERE r.user_id = $1 AND r.id = $2 AND r.deleted_at IS NULL FOR UPDATE",
		userID, id)
	return scanFull(row)
}

const updateResume = `
UPDATE resumes SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    title = $6, target_role = $7, target_company = $8, jd_id = $9,
    structured = $10, content = $11, content_hash = $12, schema_version = $13,
    status = $14, quality_status = $15, quality_issues = $16,
    quality_gate_version = $17, score = $18, evidence_summary = $19,
    risk_summary = $20, missing_info = $21
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new resume row under an optimistic lock.
func (r *Repository) UpdateAggregate(ctx context.Context, tx pgx.Tx, resume domain.Resume) error {
	tag, err := tx.Exec(ctx, updateResume,
		resume.UserID, resume.ID, resume.EntityVersion, resume.UpdatedAt,
		resume.LastModifiedDeviceID, resume.Title, resume.TargetRole, resume.TargetCompany,
		resume.JdID, resume.Structured, resume.Content, resume.ContentHash,
		resume.SchemaVersion, string(resume.Status), string(resume.QualityStatus),
		resume.QualityIssues, resume.QualityGateVersion, resume.Score,
		resume.EvidenceSummary, resume.RiskSummary, resume.MissingInfo,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

const softDeleteResume = `
UPDATE resumes SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks a resume deleted under an optimistic lock.
func (r *Repository) SoftDelete(ctx context.Context, tx pgx.Tx, resume domain.Resume) error {
	tag, err := tx.Exec(ctx, softDeleteResume,
		resume.UserID, resume.ID, resume.EntityVersion, resume.DeletedAt,
		resume.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

func ordinal(n int) string {
	return strconv.Itoa(n)
}
