package postgres

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"

	"github.com/jackc/pgx/v5"
)

const insertJD = `
INSERT INTO job_descriptions (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    title, company, target_role, source_kind, source_url, raw_text, jd_hash,
    requirements_origin, status
) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

// Insert writes a new JD and its requirements.
func (r *Repository) Insert(ctx context.Context, tx pgx.Tx, jd domain.JobDescription) error {
	if _, err := tx.Exec(ctx, insertJD,
		jd.ID, jd.UserID, jd.EntityVersion, jd.CreatedAt, jd.LastModifiedDeviceID,
		jd.Title, jd.Company, jd.TargetRole, string(jd.SourceKind), jd.SourceURL,
		jd.RawText, jd.JdHash, string(jd.RequirementsOrigin), string(jd.Status),
	); err != nil {
		return err
	}
	return r.insertRequirements(ctx, tx, jd.UserID, jd.ID, jd.Requirements)
}

const insertRequirement = `
INSERT INTO jd_requirements (
    id, user_id, jd_id, text, category, importance, keywords, weight,
    sort_order, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`

func (r *Repository) insertRequirements(
	ctx context.Context, tx pgx.Tx, userID, jdID string, requirements []domain.Requirement,
) error {
	for _, req := range requirements {
		if _, err := tx.Exec(ctx, insertRequirement,
			req.ID, userID, jdID, req.Text, string(req.Category), string(req.Importance),
			req.Keywords, req.Weight, req.SortOrder, req.CreatedAt,
		); err != nil {
			return err
		}
	}
	return nil
}

// LoadForUpdate loads a JD with a row lock.
func (r *Repository) LoadForUpdate(
	ctx context.Context, tx pgx.Tx, userID, id string,
) (domain.JobDescription, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+jdColumns+" FROM job_descriptions j WHERE j.user_id = $1 AND j.id = $2 AND j.deleted_at IS NULL FOR UPDATE",
		userID, id)
	return scanJD(row)
}

const updateJD = `
UPDATE job_descriptions SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    title = $6, company = $7, target_role = $8, source_kind = $9, source_url = $10,
    raw_text = $11, jd_hash = $12, requirements_origin = $13, status = $14
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new JD row under an optimistic lock.
func (r *Repository) UpdateAggregate(ctx context.Context, tx pgx.Tx, jd domain.JobDescription) error {
	tag, err := tx.Exec(ctx, updateJD,
		jd.UserID, jd.ID, jd.EntityVersion, jd.UpdatedAt, jd.LastModifiedDeviceID,
		jd.Title, jd.Company, jd.TargetRole, string(jd.SourceKind), jd.SourceURL,
		jd.RawText, jd.JdHash, string(jd.RequirementsOrigin), string(jd.Status),
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

// ReplaceRequirements deletes all requirements and reinserts the new set. The
// deferred UNIQUE(jd_id, sort_order) constraint tolerates in-transaction churn.
func (r *Repository) ReplaceRequirements(
	ctx context.Context, tx pgx.Tx, userID, jdID string, requirements []domain.Requirement,
) error {
	if _, err := tx.Exec(ctx,
		"DELETE FROM jd_requirements WHERE user_id = $1 AND jd_id = $2", userID, jdID,
	); err != nil {
		return err
	}
	return r.insertRequirements(ctx, tx, userID, jdID, requirements)
}

const softDeleteJD = `
UPDATE job_descriptions SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks a JD deleted under an optimistic lock.
func (r *Repository) SoftDelete(ctx context.Context, tx pgx.Tx, jd domain.JobDescription) error {
	tag, err := tx.Exec(ctx, softDeleteJD,
		jd.UserID, jd.ID, jd.EntityVersion, jd.DeletedAt, jd.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

var _ application.Repository = (*Repository)(nil)
