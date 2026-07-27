package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/experience/application"
	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository loads and stores experiences and their revisions.
type Repository struct {
	pool *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

const experienceColumns = `
e.id, e.entity_version, e.created_at, e.updated_at, e.deleted_at,
e.last_modified_device_id, e.category, e.title, e.organization, e.role,
e.location, e.start_date::text, e.end_date::text, e.tags, e.status,
e.current_revision_id`

func scanExperience(row pgx.Row) (domain.Experience, error) {
	var e domain.Experience
	err := row.Scan(
		&e.ID, &e.EntityVersion, &e.CreatedAt, &e.UpdatedAt, &e.DeletedAt,
		&e.LastModifiedDeviceID, &e.Category, &e.Title, &e.Organization, &e.Role,
		&e.Location, &e.StartDate, &e.EndDate, &e.Tags, &e.Status,
		&e.CurrentRevisionID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Experience{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Experience{}, err
	}
	return e, nil
}

// FindDetail returns one experience with its current revision and history.
func (r *Repository) FindDetail(ctx context.Context, userID, id string) (domain.Experience, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+experienceColumns+" FROM experiences e WHERE e.user_id = $1 AND e.id = $2 AND e.deleted_at IS NULL",
		userID, id)
	exp, err := scanExperience(row)
	if err != nil {
		return domain.Experience{}, err
	}
	revisions, err := r.loadRevisions(ctx, userID, id)
	if err != nil {
		return domain.Experience{}, err
	}
	exp.Revisions = revisions
	if exp.CurrentRevisionID != nil {
		for i := range revisions {
			if revisions[i].ID == *exp.CurrentRevisionID {
				exp.CurrentRevision = &revisions[i]
				break
			}
		}
	}
	return exp, nil
}

const revisionColumns = `
id, experience_id, revision_number, content, source, revision_hash,
created_by_device_id, created_at`

func (r *Repository) loadRevisions(ctx context.Context, userID, expID string) ([]domain.Revision, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+revisionColumns+" FROM experience_revisions WHERE user_id = $1 AND experience_id = $2 ORDER BY revision_number DESC",
		userID, expID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRevisions(rows)
}

func scanRevisions(rows pgx.Rows) ([]domain.Revision, error) {
	revisions := make([]domain.Revision, 0)
	for rows.Next() {
		var rev domain.Revision
		if err := rows.Scan(
			&rev.ID, &rev.ExperienceID, &rev.RevisionNumber, &rev.Content,
			&rev.Source, &rev.RevisionHash, &rev.CreatedByDevice, &rev.CreatedAt,
		); err != nil {
			return nil, err
		}
		revisions = append(revisions, rev)
	}
	return revisions, rows.Err()
}

// ListRevisions returns keyset-paginated revisions newest first.
func (r *Repository) ListRevisions(
	ctx context.Context, userID, expID string, afterNumber, limit int,
) ([]domain.Revision, error) {
	const base = "SELECT " + revisionColumns +
		" FROM experience_revisions WHERE user_id = $1 AND experience_id = $2"
	var rows pgx.Rows
	var err error
	if afterNumber > 0 {
		rows, err = r.pool.Query(ctx,
			base+" AND revision_number < $3 ORDER BY revision_number DESC LIMIT $4",
			userID, expID, afterNumber, limit)
	} else {
		rows, err = r.pool.Query(ctx,
			base+" ORDER BY revision_number DESC LIMIT $3", userID, expID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRevisions(rows)
}

// HydrateByIDs loads current experiences for the given IDs, including
// soft-deleted rows so the sync feed can project tombstones.
func (r *Repository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.Experience, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+experienceColumns+" FROM experiences e WHERE e.user_id = $1 AND e.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.Experience, len(ids))
	for rows.Next() {
		exp, scanErr := scanExperience(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[exp.ID] = exp
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := r.attachCurrentRevisions(ctx, userID, result); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *Repository) attachCurrentRevisions(
	ctx context.Context, userID string, experiences map[string]domain.Experience,
) error {
	for id, exp := range experiences {
		if exp.CurrentRevisionID == nil || exp.DeletedAt != nil {
			continue
		}
		row := r.pool.QueryRow(ctx,
			"SELECT "+revisionColumns+" FROM experience_revisions WHERE user_id = $1 AND id = $2",
			userID, *exp.CurrentRevisionID)
		var rev domain.Revision
		if err := row.Scan(
			&rev.ID, &rev.ExperienceID, &rev.RevisionNumber, &rev.Content,
			&rev.Source, &rev.RevisionHash, &rev.CreatedByDevice, &rev.CreatedAt,
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return err
		}
		exp.CurrentRevision = &rev
		experiences[id] = exp
	}
	return nil
}

var _ application.Repository = (*Repository)(nil)
