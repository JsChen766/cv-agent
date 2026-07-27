package postgres

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// List returns keyset-paginated interview rounds for one application.
func (r *InterviewRepository) List(
	ctx context.Context, userID, appID string, filter application.ChildFilter,
) ([]domain.InterviewRound, error) {
	query := "SELECT " + interviewColumns +
		" FROM interview_rounds i WHERE i.user_id = $1 AND i.application_id = $2 AND i.deleted_at IS NULL"
	args := []any{userID, appID}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		query += " AND (i.updated_at, i.id) < ($" + ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")"
	}
	args = append(args, filter.Limit)
	query += " ORDER BY i.updated_at DESC, i.id DESC LIMIT $" + ordinal(len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.InterviewRound, 0, filter.Limit)
	for rows.Next() {
		round, scanErr := scanInterview(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, round)
	}
	return result, rows.Err()
}

// HydrateByIDs loads interview rounds for the IDs, including soft-deleted rows.
func (r *InterviewRepository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.InterviewRound, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+interviewColumns+" FROM interview_rounds i WHERE i.user_id = $1 AND i.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.InterviewRound, len(ids))
	for rows.Next() {
		round, scanErr := scanInterview(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[round.ID] = round
	}
	return result, rows.Err()
}

// BootstrapPage returns active interview rounds ordered by id for bootstrap.
func (r *InterviewRepository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.InterviewRound, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+interviewColumns+" FROM interview_rounds i"+
			" JOIN applications a ON a.user_id = i.user_id AND a.id = i.application_id"+
			" WHERE i.user_id = $1 AND i.deleted_at IS NULL AND a.deleted_at IS NULL AND i.id > $2"+
			" ORDER BY i.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.InterviewRound, 0, limit)
	for rows.Next() {
		round, scanErr := scanInterview(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, round)
	}
	return result, rows.Err()
}
