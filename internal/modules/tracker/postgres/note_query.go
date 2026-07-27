package postgres

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// List returns keyset-paginated notes for one application.
func (r *NoteRepository) List(
	ctx context.Context, userID, appID string, filter application.ChildFilter,
) ([]domain.Note, error) {
	query := "SELECT " + noteColumns +
		" FROM application_notes n WHERE n.user_id = $1 AND n.application_id = $2 AND n.deleted_at IS NULL"
	args := []any{userID, appID}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		query += " AND (n.updated_at, n.id) < ($" + ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")"
	}
	args = append(args, filter.Limit)
	query += " ORDER BY n.updated_at DESC, n.id DESC LIMIT $" + ordinal(len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Note, 0, filter.Limit)
	for rows.Next() {
		note, scanErr := scanNote(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, note)
	}
	return result, rows.Err()
}

// HydrateByIDs loads notes for the IDs, including soft-deleted rows.
func (r *NoteRepository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.Note, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+noteColumns+" FROM application_notes n WHERE n.user_id = $1 AND n.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.Note, len(ids))
	for rows.Next() {
		note, scanErr := scanNote(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[note.ID] = note
	}
	return result, rows.Err()
}

// BootstrapPage returns active notes ordered by id for bootstrap.
func (r *NoteRepository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.Note, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+noteColumns+" FROM application_notes n"+
			" JOIN applications a ON a.user_id = n.user_id AND a.id = n.application_id"+
			" WHERE n.user_id = $1 AND n.deleted_at IS NULL AND a.deleted_at IS NULL AND n.id > $2"+
			" ORDER BY n.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Note, 0, limit)
	for rows.Next() {
		note, scanErr := scanNote(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, note)
	}
	return result, rows.Err()
}
