package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository loads and stores job descriptions and their requirements.
type Repository struct {
	pool *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

const jdColumns = `
j.id, j.entity_version, j.created_at, j.updated_at, j.deleted_at,
j.last_modified_device_id, j.title, j.company, j.target_role, j.source_kind,
j.source_url, j.raw_text, j.jd_hash, j.requirements_origin, j.status`

func scanJD(row pgx.Row) (domain.JobDescription, error) {
	var jd domain.JobDescription
	err := row.Scan(
		&jd.ID, &jd.EntityVersion, &jd.CreatedAt, &jd.UpdatedAt, &jd.DeletedAt,
		&jd.LastModifiedDeviceID, &jd.Title, &jd.Company, &jd.TargetRole, &jd.SourceKind,
		&jd.SourceURL, &jd.RawText, &jd.JdHash, &jd.RequirementsOrigin, &jd.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.JobDescription{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.JobDescription{}, err
	}
	return jd, nil
}

const requirementColumns = `
id, text, category, importance, keywords, weight, sort_order, created_at, updated_at`

func (r *Repository) loadRequirements(ctx context.Context, userID, jdID string) ([]domain.Requirement, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+requirementColumns+" FROM jd_requirements WHERE user_id = $1 AND jd_id = $2 ORDER BY sort_order",
		userID, jdID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRequirements(rows)
}

func scanRequirements(rows pgx.Rows) ([]domain.Requirement, error) {
	requirements := make([]domain.Requirement, 0)
	for rows.Next() {
		var req domain.Requirement
		if err := rows.Scan(
			&req.ID, &req.Text, &req.Category, &req.Importance, &req.Keywords,
			&req.Weight, &req.SortOrder, &req.CreatedAt, &req.UpdatedAt,
		); err != nil {
			return nil, err
		}
		requirements = append(requirements, req)
	}
	return requirements, rows.Err()
}

// FindDetail returns one JD with its requirements.
func (r *Repository) FindDetail(ctx context.Context, userID, id string) (domain.JobDescription, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+jdColumns+" FROM job_descriptions j WHERE j.user_id = $1 AND j.id = $2 AND j.deleted_at IS NULL",
		userID, id)
	jd, err := scanJD(row)
	if err != nil {
		return domain.JobDescription{}, err
	}
	requirements, err := r.loadRequirements(ctx, userID, id)
	if err != nil {
		return domain.JobDescription{}, err
	}
	jd.Requirements = requirements
	return jd, nil
}

// List returns keyset-paginated JDs ordered by (updated_at DESC, id DESC).
func (r *Repository) List(
	ctx context.Context, userID string, filter application.ListFilter,
) ([]domain.JobDescription, error) {
	var rows pgx.Rows
	var err error
	const base = "SELECT " + jdColumns +
		" FROM job_descriptions j WHERE j.user_id = $1 AND j.deleted_at IS NULL"
	if filter.HasKey {
		rows, err = r.pool.Query(ctx,
			base+" AND (j.updated_at, j.id) < ($2, $3) ORDER BY j.updated_at DESC, j.id DESC LIMIT $4",
			userID, filter.Cursor.UpdatedAt, filter.Cursor.ID, filter.Limit)
	} else {
		rows, err = r.pool.Query(ctx,
			base+" ORDER BY j.updated_at DESC, j.id DESC LIMIT $2", userID, filter.Limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return r.collectWithRequirements(ctx, userID, rows)
}

// BootstrapPage returns active JDs ordered by id for cursor bootstrap.
func (r *Repository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.JobDescription, error) {
	if afterID == "" {
		afterID = "00000000-0000-0000-0000-000000000000"
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+jdColumns+" FROM job_descriptions j"+
			" WHERE j.user_id = $1 AND j.deleted_at IS NULL AND j.id > $2"+
			" ORDER BY j.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return r.collectWithRequirements(ctx, userID, rows)
}

func (r *Repository) collectWithRequirements(
	ctx context.Context, userID string, rows pgx.Rows,
) ([]domain.JobDescription, error) {
	result := make([]domain.JobDescription, 0)
	for rows.Next() {
		jd, err := scanJD(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, jd)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range result {
		requirements, err := r.loadRequirements(ctx, userID, result[i].ID)
		if err != nil {
			return nil, err
		}
		result[i].Requirements = requirements
	}
	return result, nil
}

// HydrateByIDs loads current JDs for the given IDs, including soft-deleted rows.
func (r *Repository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.JobDescription, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+jdColumns+" FROM job_descriptions j WHERE j.user_id = $1 AND j.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[string]domain.JobDescription, len(ids))
	for rows.Next() {
		jd, scanErr := scanJD(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		byID[jd.ID] = jd
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for id, jd := range byID {
		if jd.DeletedAt != nil {
			continue
		}
		requirements, reqErr := r.loadRequirements(ctx, userID, id)
		if reqErr != nil {
			return nil, reqErr
		}
		jd.Requirements = requirements
		byID[id] = jd
	}
	return byID, nil
}
