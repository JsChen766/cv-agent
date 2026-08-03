package postgres

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"

	"github.com/jackc/pgx/v5"
)

const insertExperience = `
INSERT INTO experiences (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    category, title, organization, role, location, start_date, end_date,
    tags, resume_section_key, resume_section_label, status, current_revision_id
) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL)`

const insertRevision = `
INSERT INTO experience_revisions (
    id, user_id, experience_id, revision_number, content, source,
    revision_hash, created_by_device_id, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

const setCurrentRevision = `
UPDATE experiences SET current_revision_id = $3
WHERE user_id = $1 AND id = $2`

// Insert writes a new experience and its first revision, then links it as the
// current revision. The deferred FK on current_revision_id is satisfied by
// inserting the revision before the final UPDATE.
func (r *Repository) Insert(
	ctx context.Context, tx pgx.Tx, exp domain.Experience, rev domain.Revision,
) error {
	if _, err := tx.Exec(ctx, insertExperience,
		exp.ID, exp.UserID, exp.EntityVersion, exp.CreatedAt, exp.LastModifiedDeviceID,
		string(exp.Category), exp.Title, exp.Organization, exp.Role, exp.Location,
		nullableDate(exp.StartDate), nullableDate(exp.EndDate), exp.Tags,
		exp.ResumeSectionKey, exp.ResumeSectionLabel, string(exp.Status),
	); err != nil {
		return err
	}
	if err := r.InsertRevision(ctx, tx, rev); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, setCurrentRevision, exp.UserID, exp.ID, rev.ID)
	return err
}

// InsertRevision appends an immutable revision row.
func (r *Repository) InsertRevision(ctx context.Context, tx pgx.Tx, rev domain.Revision) error {
	_, err := tx.Exec(ctx, insertRevision,
		rev.ID, rev.UserID, rev.ExperienceID, rev.RevisionNumber, rev.Content,
		string(rev.Source), rev.RevisionHash, rev.CreatedByDevice, rev.CreatedAt,
	)
	return err
}

// LoadForUpdate loads an experience with a row lock and its current revision.
func (r *Repository) LoadForUpdate(
	ctx context.Context, tx pgx.Tx, userID, id string,
) (domain.Experience, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+experienceColumns+" FROM experiences e WHERE e.user_id = $1 AND e.id = $2 FOR UPDATE",
		userID, id)
	exp, err := scanExperience(row)
	if err != nil {
		return domain.Experience{}, err
	}
	if exp.CurrentRevisionID != nil {
		row := tx.QueryRow(ctx,
			"SELECT "+revisionColumns+" FROM experience_revisions WHERE user_id = $1 AND id = $2",
			userID, *exp.CurrentRevisionID)
		var rev domain.Revision
		if scanErr := row.Scan(
			&rev.ID, &rev.ExperienceID, &rev.RevisionNumber, &rev.Content,
			&rev.Source, &rev.RevisionHash, &rev.CreatedByDevice, &rev.CreatedAt,
		); scanErr == nil {
			exp.CurrentRevision = &rev
		} else if scanErr != pgx.ErrNoRows {
			return domain.Experience{}, scanErr
		}
	}
	return exp, nil
}

const updateAggregate = `
UPDATE experiences SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    category = $6, title = $7, organization = $8, role = $9, location = $10,
    start_date = $11, end_date = $12, tags = $13, resume_section_key = $14,
    resume_section_label = $15, status = $16, current_revision_id = $17
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new aggregate row under an optimistic lock.
func (r *Repository) UpdateAggregate(ctx context.Context, tx pgx.Tx, exp domain.Experience) error {
	tag, err := tx.Exec(ctx, updateAggregate,
		exp.UserID, exp.ID, exp.EntityVersion, exp.UpdatedAt, exp.LastModifiedDeviceID,
		string(exp.Category), exp.Title, exp.Organization, exp.Role, exp.Location,
		nullableDate(exp.StartDate), nullableDate(exp.EndDate), exp.Tags,
		exp.ResumeSectionKey, exp.ResumeSectionLabel, string(exp.Status),
		exp.CurrentRevisionID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

const softDelete = `
UPDATE experiences SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks an experience deleted under an optimistic lock.
func (r *Repository) SoftDelete(ctx context.Context, tx pgx.Tx, exp domain.Experience) error {
	tag, err := tx.Exec(ctx, softDelete,
		exp.UserID, exp.ID, exp.EntityVersion, exp.DeletedAt, exp.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

func nullableDate(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}
