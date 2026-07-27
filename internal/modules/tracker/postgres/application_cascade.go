package postgres

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"

	"github.com/jackc/pgx/v5"
)

// ApplicationCascadeRepository soft-deletes mutable application children.
type ApplicationCascadeRepository struct{}

// NewApplicationCascadeRepository constructs the aggregate cascade adapter.
func NewApplicationCascadeRepository() *ApplicationCascadeRepository {
	return &ApplicationCascadeRepository{}
}

// SoftDeleteChildren returns every child version that needs a sync tombstone.
func (r *ApplicationCascadeRepository) SoftDeleteChildren(
	ctx context.Context, tx pgx.Tx, userID, appID string,
	deviceID *string, deletedAt time.Time,
) (application.DeletedChildren, error) {
	interviews, err := deleteChildren(ctx, tx, "interview_rounds", userID, appID, deviceID, deletedAt)
	if err != nil {
		return application.DeletedChildren{}, err
	}
	notes, err := deleteChildren(ctx, tx, "application_notes", userID, appID, deviceID, deletedAt)
	if err != nil {
		return application.DeletedChildren{}, err
	}
	reminders, err := deleteChildren(ctx, tx, "reminders", userID, appID, deviceID, deletedAt)
	if err != nil {
		return application.DeletedChildren{}, err
	}
	return application.DeletedChildren{
		Interviews: interviews, Notes: notes, Reminders: reminders,
	}, nil
}

func deleteChildren(
	ctx context.Context, tx pgx.Tx, table, userID, appID string,
	deviceID *string, deletedAt time.Time,
) ([]application.VersionedID, error) {
	query := "UPDATE " + table + ` SET
entity_version = entity_version + 1, updated_at = $3, deleted_at = $3,
last_modified_device_id = $4
WHERE user_id = $1 AND application_id = $2 AND deleted_at IS NULL
RETURNING id, entity_version`
	rows, err := tx.Query(ctx, query, userID, appID, deletedAt, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]application.VersionedID, 0)
	for rows.Next() {
		var child application.VersionedID
		if err := rows.Scan(&child.ID, &child.Version); err != nil {
			return nil, err
		}
		result = append(result, child)
	}
	return result, rows.Err()
}
