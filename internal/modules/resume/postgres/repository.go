package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/resume/application"
	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository loads and stores resumes.
type Repository struct {
	pool *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

const summaryColumns = `
r.id, r.entity_version, r.created_at, r.updated_at, r.deleted_at,
r.last_modified_device_id, r.title, r.target_role, r.target_company, r.jd_id,
r.content_hash, r.schema_version, r.status, r.quality_status, r.quality_gate_version`

const fullColumns = summaryColumns + `,
r.structured, r.content, r.quality_issues, r.score, r.evidence_summary,
r.risk_summary, r.missing_info`

func scanSummary(row pgx.Row) (domain.Resume, error) {
	var r domain.Resume
	err := row.Scan(
		&r.ID, &r.EntityVersion, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt,
		&r.LastModifiedDeviceID, &r.Title, &r.TargetRole, &r.TargetCompany, &r.JdID,
		&r.ContentHash, &r.SchemaVersion, &r.Status, &r.QualityStatus, &r.QualityGateVersion,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Resume{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Resume{}, err
	}
	return r, nil
}

func scanFull(row pgx.Row) (domain.Resume, error) {
	var r domain.Resume
	err := row.Scan(
		&r.ID, &r.EntityVersion, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt,
		&r.LastModifiedDeviceID, &r.Title, &r.TargetRole, &r.TargetCompany, &r.JdID,
		&r.ContentHash, &r.SchemaVersion, &r.Status, &r.QualityStatus, &r.QualityGateVersion,
		&r.Structured, &r.Content, &r.QualityIssues, &r.Score, &r.EvidenceSummary,
		&r.RiskSummary, &r.MissingInfo,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Resume{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Resume{}, err
	}
	return r, nil
}

// FindDetail returns one full resume.
func (r *Repository) FindDetail(ctx context.Context, userID, id string) (domain.Resume, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+fullColumns+" FROM resumes r WHERE r.user_id = $1 AND r.id = $2 AND r.deleted_at IS NULL",
		userID, id)
	return scanFull(row)
}

// List returns keyset-paginated resume summaries ordered by (updated_at DESC, id DESC).
func (r *Repository) List(
	ctx context.Context, userID string, filter application.ListFilter,
) ([]domain.Resume, error) {
	base := "SELECT " + summaryColumns +
		" FROM resumes r WHERE r.user_id = $1 AND r.deleted_at IS NULL"
	args := []any{userID}
	if filter.Status != nil {
		args = append(args, string(*filter.Status))
		base += " AND r.status = $2"
	}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		base += " AND (r.updated_at, r.id) < ($" + ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")"
	}
	args = append(args, filter.Limit)
	base += " ORDER BY r.updated_at DESC, r.id DESC LIMIT $" + ordinal(len(args))

	rows, err := r.pool.Query(ctx, base, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Resume, 0, filter.Limit)
	for rows.Next() {
		resume, scanErr := scanSummary(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, resume)
	}
	return result, rows.Err()
}

// HydrateByIDs loads full resumes for the given IDs, including soft-deleted rows
// so the sync feed can project tombstones.
func (r *Repository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.Resume, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+fullColumns+" FROM resumes r WHERE r.user_id = $1 AND r.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.Resume, len(ids))
	for rows.Next() {
		resume, scanErr := scanFull(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[resume.ID] = resume
	}
	return result, rows.Err()
}

// BootstrapPage returns active full resumes ordered by id for cursor bootstrap.
func (r *Repository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.Resume, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+fullColumns+" FROM resumes r"+
			" WHERE r.user_id = $1 AND r.deleted_at IS NULL AND r.id > $2"+
			" ORDER BY r.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Resume, 0, limit)
	for rows.Next() {
		resume, scanErr := scanFull(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, resume)
	}
	return result, rows.Err()
}

const zeroUUID = "00000000-0000-0000-0000-000000000000"

var _ application.Repository = (*Repository)(nil)
