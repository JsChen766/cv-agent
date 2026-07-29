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
		" FROM experiences e LEFT JOIN experience_revisions cr" +
		" ON cr.user_id = e.user_id AND cr.id = e.current_revision_id" +
		" WHERE e.user_id = $1 AND e.deleted_at IS NULL")
	args := []any{userID}
	args = append(args, string(filter.Status))
	builder.WriteString(" AND e.status = $" + ordinal(len(args)))
	if filter.Category != nil {
		args = append(args, string(*filter.Category))
		builder.WriteString(" AND e.category = $" + ordinal(len(args)))
	}
	if trimmed := strings.TrimSpace(filter.Query); trimmed != "" {
		args = append(args, trimmed)
		arg := "$" + ordinal(len(args))
		builder.WriteString(" AND strpos(lower(normalize(concat_ws(' ', e.title," +
			" e.organization, e.role, e.location, array_to_string(e.tags, ' ')," +
			" cr.content), NFKC)), lower(normalize(btrim(" + arg + "), NFKC))) > 0")
	}
	if len(filter.Tags) > 0 {
		args = append(args, filter.Tags)
		arg := "$" + ordinal(len(args))
		builder.WriteString(" AND NOT EXISTS (SELECT 1 FROM unnest(" + arg +
			"::text[]) wanted WHERE NOT EXISTS (SELECT 1 FROM unnest(e.tags) actual" +
			" WHERE lower(normalize(btrim(actual), NFKC)) =" +
			" lower(normalize(btrim(wanted), NFKC))))")
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
