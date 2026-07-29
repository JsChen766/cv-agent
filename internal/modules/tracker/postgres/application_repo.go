package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ApplicationRepository loads and stores tracker applications and status events.
type ApplicationRepository struct {
	pool *pgxpool.Pool
}

// NewApplicationRepository constructs an ApplicationRepository.
func NewApplicationRepository(pool *pgxpool.Pool) *ApplicationRepository {
	return &ApplicationRepository{pool: pool}
}

const applicationColumns = `
a.id, a.entity_version, a.created_at, a.updated_at, a.deleted_at,
a.last_modified_device_id, a.jd_id, a.resume_id, a.company_name, a.role_name,
a.jd_title_snapshot, a.resume_title_snapshot, a.resume_content_hash_snapshot,
a.delivery_method, a.target_url,
a.applied_at, a.status, a.pending_confirmation, a.source, a.dedupe_key,
a.company_business, a.role_summary, a.company_culture, a.rejection_reason`

func scanApplication(row pgx.Row) (domain.Application, error) {
	var a domain.Application
	err := row.Scan(
		&a.ID, &a.EntityVersion, &a.CreatedAt, &a.UpdatedAt, &a.DeletedAt,
		&a.LastModifiedDeviceID, &a.JdID, &a.ResumeID, &a.CompanyName, &a.RoleName,
		&a.JdTitleSnapshot, &a.ResumeTitleSnapshot, &a.ResumeContentHashSnapshot,
		&a.DeliveryMethod, &a.TargetURL,
		&a.AppliedAt, &a.Status, &a.PendingConfirmation, &a.Source, &a.DedupeKey,
		&a.CompanyBusiness, &a.RoleSummary, &a.CompanyCulture, &a.RejectionReason,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Application{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Application{}, err
	}
	return a, nil
}

const insertApplication = `
INSERT INTO applications (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    jd_id, resume_id, company_name, role_name, jd_title_snapshot,
    resume_title_snapshot, resume_content_hash_snapshot, delivery_method,
    target_url, applied_at, status,
    pending_confirmation, source, dedupe_key, company_business, role_summary,
    company_culture, rejection_reason
) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
    $15, $16, $17, $18, $19, $20, $21, $22, $23)`

// Insert writes a new application row.
func (r *ApplicationRepository) Insert(ctx context.Context, tx pgx.Tx, a domain.Application) error {
	_, err := tx.Exec(ctx, insertApplication,
		a.ID, a.UserID, a.EntityVersion, a.CreatedAt, a.LastModifiedDeviceID,
		a.JdID, a.ResumeID, a.CompanyName, a.RoleName, a.JdTitleSnapshot,
		a.ResumeTitleSnapshot, a.ResumeContentHashSnapshot, string(a.DeliveryMethod),
		a.TargetURL, a.AppliedAt,
		string(a.Status), a.PendingConfirmation, string(a.Source), a.DedupeKey,
		a.CompanyBusiness, a.RoleSummary, a.CompanyCulture, a.RejectionReason,
	)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return domain.ErrDuplicate
	}
	return err
}

// FindDetail returns one active application.
func (r *ApplicationRepository) FindDetail(ctx context.Context, userID, id string) (domain.Application, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+applicationColumns+" FROM applications a WHERE a.user_id = $1 AND a.id = $2 AND a.deleted_at IS NULL",
		userID, id)
	return scanApplication(row)
}

// LoadForUpdate loads an application with a row lock.
func (r *ApplicationRepository) LoadForUpdate(
	ctx context.Context, tx pgx.Tx, userID, id string,
) (domain.Application, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+applicationColumns+" FROM applications a WHERE a.user_id = $1 AND a.id = $2 AND a.deleted_at IS NULL FOR UPDATE",
		userID, id)
	return scanApplication(row)
}

const updateApplication = `
UPDATE applications SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    jd_id = $6, resume_id = $7, company_name = $8, role_name = $9,
    jd_title_snapshot = $10, resume_title_snapshot = $11,
    resume_content_hash_snapshot = $12, delivery_method = $13, target_url = $14,
    applied_at = $15, status = $16, pending_confirmation = $17,
    company_business = $18, role_summary = $19, company_culture = $20,
    rejection_reason = $21
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new application row under an optimistic lock.
func (r *ApplicationRepository) UpdateAggregate(ctx context.Context, tx pgx.Tx, a domain.Application) error {
	tag, err := tx.Exec(ctx, updateApplication,
		a.UserID, a.ID, a.EntityVersion, a.UpdatedAt, a.LastModifiedDeviceID,
		a.JdID, a.ResumeID, a.CompanyName, a.RoleName,
		a.JdTitleSnapshot, a.ResumeTitleSnapshot, a.ResumeContentHashSnapshot,
		string(a.DeliveryMethod), a.TargetURL, a.AppliedAt, string(a.Status),
		a.PendingConfirmation,
		a.CompanyBusiness, a.RoleSummary, a.CompanyCulture, a.RejectionReason,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

const softDeleteApplication = `
UPDATE applications SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks an application deleted under an optimistic lock.
func (r *ApplicationRepository) SoftDelete(ctx context.Context, tx pgx.Tx, a domain.Application) error {
	tag, err := tx.Exec(ctx, softDeleteApplication,
		a.UserID, a.ID, a.EntityVersion, a.DeletedAt, a.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

var _ application.ApplicationRepository = (*ApplicationRepository)(nil)
