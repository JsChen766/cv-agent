package postgres

import (
	"context"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

const zeroUUID = "00000000-0000-0000-0000-000000000000"

func ordinal(n int) string { return strconv.Itoa(n) }

// List returns keyset-paginated applications filtered by the board criteria.
func (r *ApplicationRepository) List(
	ctx context.Context, userID string, filter application.ApplicationFilter,
) ([]domain.Application, error) {
	query := "SELECT " + applicationColumns +
		" FROM applications a WHERE a.user_id = $1 AND a.deleted_at IS NULL"
	args := []any{userID}
	if filter.Status != nil {
		args = append(args, string(*filter.Status))
		query += " AND a.status = $" + ordinal(len(args))
	}
	if filter.Company != "" {
		args = append(args, "%"+filter.Company+"%")
		query += " AND a.company_name ILIKE $" + ordinal(len(args))
	}
	if filter.JdID != nil {
		args = append(args, *filter.JdID)
		query += " AND a.jd_id = $" + ordinal(len(args))
	}
	if filter.ResumeID != nil {
		args = append(args, *filter.ResumeID)
		query += " AND a.resume_id = $" + ordinal(len(args))
	}
	if filter.PendingConfirmation != nil {
		args = append(args, *filter.PendingConfirmation)
		query += " AND a.pending_confirmation = $" + ordinal(len(args))
	}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		query += " AND (a.updated_at, a.id) < ($" + ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")"
	}
	args = append(args, filter.Limit)
	query += " ORDER BY a.updated_at DESC, a.id DESC LIMIT $" + ordinal(len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Application, 0, filter.Limit)
	for rows.Next() {
		app, scanErr := scanApplication(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, app)
	}
	return result, rows.Err()
}

// HydrateByIDs loads applications for the IDs, including soft-deleted rows so
// the sync feed can project tombstones.
func (r *ApplicationRepository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.Application, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+applicationColumns+" FROM applications a WHERE a.user_id = $1 AND a.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.Application, len(ids))
	for rows.Next() {
		app, scanErr := scanApplication(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[app.ID] = app
	}
	return result, rows.Err()
}

// BootstrapPage returns active applications ordered by id for cursor bootstrap.
func (r *ApplicationRepository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.Application, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+applicationColumns+" FROM applications a"+
			" WHERE a.user_id = $1 AND a.deleted_at IS NULL AND a.id > $2"+
			" ORDER BY a.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Application, 0, limit)
	for rows.Next() {
		app, scanErr := scanApplication(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, app)
	}
	return result, rows.Err()
}
