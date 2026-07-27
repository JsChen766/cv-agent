package postgres

import (
	"context"
	"strconv"
	"strings"

	"coolto.local/cv-agent-app-be/internal/modules/experience/application"
	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
)

// List returns keyset-paginated experience summaries filtered by the criteria.
// Deleted rows are excluded; the keyset orders by (updated_at DESC, id DESC).
func (r *Repository) List(
	ctx context.Context, userID string, filter application.ListFilter,
) ([]domain.Experience, error) {
	builder := strings.Builder{}
	builder.WriteString("SELECT " + experienceColumns +
		" FROM experiences e WHERE e.user_id = $1 AND e.deleted_at IS NULL")
	args := []any{userID}
	if filter.Category != nil {
		args = append(args, string(*filter.Category))
		builder.WriteString(" AND e.category = $" + ordinal(len(args)))
	}
	if trimmed := strings.TrimSpace(filter.Query); trimmed != "" {
		args = append(args, "%"+trimmed+"%")
		builder.WriteString(" AND (e.title ILIKE $" + ordinal(len(args)) +
			" OR e.organization ILIKE $" + ordinal(len(args)) +
			" OR e.role ILIKE $" + ordinal(len(args)) + ")")
	}
	if len(filter.Tags) > 0 {
		args = append(args, filter.Tags)
		builder.WriteString(" AND e.tags && $" + ordinal(len(args)))
	}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		builder.WriteString(" AND (e.updated_at, e.id) < ($" +
			ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")")
	}
	args = append(args, filter.Limit)
	builder.WriteString(" ORDER BY e.updated_at DESC, e.id DESC LIMIT $" + ordinal(len(args)))

	rows, err := r.pool.Query(ctx, builder.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Experience, 0, filter.Limit)
	for rows.Next() {
		exp, scanErr := scanExperience(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, exp)
	}
	return result, rows.Err()
}

// BootstrapPage returns active experiences ordered by id for cursor bootstrap.
func (r *Repository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.Experience, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+experienceColumns+" FROM experiences e"+
			" WHERE e.user_id = $1 AND e.deleted_at IS NULL AND e.id > $2"+
			" ORDER BY e.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Experience, 0, limit)
	ids := make([]string, 0, limit)
	for rows.Next() {
		exp, scanErr := scanExperience(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, exp)
		ids = append(ids, exp.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	byID := make(map[string]domain.Experience, len(result))
	for _, exp := range result {
		byID[exp.ID] = exp
	}
	if err := r.attachCurrentRevisions(ctx, userID, byID); err != nil {
		return nil, err
	}
	for i := range result {
		result[i] = byID[result[i].ID]
	}
	return result, nil
}

func ordinal(n int) string {
	return strconv.Itoa(n)
}

const zeroUUID = "00000000-0000-0000-0000-000000000000"
