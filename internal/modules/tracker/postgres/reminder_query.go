package postgres

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// List returns keyset-paginated reminders filtered by application and status.
func (r *ReminderRepository) List(
	ctx context.Context, userID string, filter application.ReminderFilter,
) ([]domain.Reminder, error) {
	query := "SELECT " + reminderColumns +
		" FROM reminders r WHERE r.user_id = $1 AND r.deleted_at IS NULL"
	args := []any{userID}
	if filter.ApplicationID != nil {
		args = append(args, *filter.ApplicationID)
		query += " AND r.application_id = $" + ordinal(len(args))
	}
	if filter.Status != nil {
		args = append(args, string(*filter.Status))
		query += " AND r.status = $" + ordinal(len(args))
	}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		query += " AND (r.updated_at, r.id) < ($" + ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")"
	}
	args = append(args, filter.Limit)
	query += " ORDER BY r.updated_at DESC, r.id DESC LIMIT $" + ordinal(len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Reminder, 0, filter.Limit)
	for rows.Next() {
		reminder, scanErr := scanReminder(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, reminder)
	}
	return result, rows.Err()
}

// HydrateByIDs loads reminders for the IDs, including soft-deleted rows.
func (r *ReminderRepository) HydrateByIDs(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.Reminder, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+reminderColumns+" FROM reminders r WHERE r.user_id = $1 AND r.id = ANY($2)",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.Reminder, len(ids))
	for rows.Next() {
		reminder, scanErr := scanReminder(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[reminder.ID] = reminder
	}
	return result, rows.Err()
}

// BootstrapPage returns active reminders ordered by id for bootstrap.
func (r *ReminderRepository) BootstrapPage(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.Reminder, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+reminderColumns+" FROM reminders r"+
			" JOIN applications a ON a.user_id = r.user_id AND a.id = r.application_id"+
			" WHERE r.user_id = $1 AND r.deleted_at IS NULL AND a.deleted_at IS NULL AND r.id > $2"+
			" ORDER BY r.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Reminder, 0, limit)
	for rows.Next() {
		reminder, scanErr := scanReminder(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, reminder)
	}
	return result, rows.Err()
}
