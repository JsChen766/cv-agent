package postgres

import (
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// LockOperation serializes direct transition retries for one user and operation.
func (r *ApplicationRepository) LockOperation(
	ctx context.Context, tx pgx.Tx, userID, operationID string,
) error {
	_, err := tx.Exec(ctx,
		"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", userID+":"+operationID,
	)
	return err
}

// FindStatusEventByOperation resolves a committed or same-transaction replay.
func (r *ApplicationRepository) FindStatusEventByOperation(
	ctx context.Context, tx pgx.Tx, userID, operationID string,
) (domain.StatusEvent, error) {
	event, err := scanStatusEvent(tx.QueryRow(ctx,
		"SELECT "+statusEventColumns+" FROM application_status_events e"+
			" WHERE e.user_id = $1 AND e.operation_id = $2",
		userID, operationID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.StatusEvent{}, domain.ErrNotFound
	}
	return event, err
}

const statusEventColumns = `
e.id, e.application_id, e.from_status, e.to_status, e.reason, e.occurred_at,
e.created_by_device_id, e.operation_id, e.created_at`

func scanStatusEvent(row pgx.Row) (domain.StatusEvent, error) {
	var e domain.StatusEvent
	err := row.Scan(
		&e.ID, &e.ApplicationID, &e.FromStatus, &e.ToStatus, &e.Reason,
		&e.OccurredAt, &e.CreatedByDevice, &e.OperationID, &e.CreatedAt,
	)
	if err != nil {
		return domain.StatusEvent{}, err
	}
	return e, nil
}

const insertStatusEvent = `
INSERT INTO application_status_events (
    id, user_id, application_id, from_status, to_status, reason, occurred_at,
    created_by_device_id, operation_id, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`

// InsertStatusEvent appends an immutable status event.
func (r *ApplicationRepository) InsertStatusEvent(
	ctx context.Context, tx pgx.Tx, e domain.StatusEvent,
) error {
	var from *string
	if e.FromStatus != nil {
		value := string(*e.FromStatus)
		from = &value
	}
	_, err := tx.Exec(ctx, insertStatusEvent,
		e.ID, e.UserID, e.ApplicationID, from, string(e.ToStatus), e.Reason,
		e.OccurredAt, e.CreatedByDevice, e.OperationID, e.CreatedAt,
	)
	return err
}

// ListStatusEvents returns keyset-paginated status events newest first ordered
// by (occurred_at DESC, id DESC).
func (r *ApplicationRepository) ListStatusEvents(
	ctx context.Context, userID, appID string, filter application.ChildFilter,
) ([]domain.StatusEvent, error) {
	query := "SELECT " + statusEventColumns +
		" FROM application_status_events e WHERE e.user_id = $1 AND e.application_id = $2"
	args := []any{userID, appID}
	if filter.HasKey {
		args = append(args, filter.Cursor.UpdatedAt, filter.Cursor.ID)
		query += " AND (e.occurred_at, e.id) < ($" + ordinal(len(args)-1) + ", $" + ordinal(len(args)) + ")"
	}
	args = append(args, filter.Limit)
	query += " ORDER BY e.occurred_at DESC, e.id DESC LIMIT $" + ordinal(len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.StatusEvent, 0, filter.Limit)
	for rows.Next() {
		event, scanErr := scanStatusEvent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, event)
	}
	return result, rows.Err()
}

// HydrateStatusEvents loads status events for the IDs. Events are immutable and
// never deleted, so tombstones do not apply.
func (r *ApplicationRepository) HydrateStatusEvents(
	ctx context.Context, userID string, ids []string,
) (map[string]domain.StatusEvent, error) {
	rows, err := r.pool.Query(ctx,
		"SELECT "+statusEventColumns+" FROM application_status_events e"+
			" JOIN applications a ON a.user_id = e.user_id AND a.id = e.application_id"+
			" WHERE e.user_id = $1 AND e.id = ANY($2) AND a.deleted_at IS NULL",
		userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]domain.StatusEvent, len(ids))
	for rows.Next() {
		event, scanErr := scanStatusEvent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[event.ID] = event
	}
	return result, rows.Err()
}

// BootstrapEvents returns status events ordered by id for cursor bootstrap.
func (r *ApplicationRepository) BootstrapEvents(
	ctx context.Context, userID, afterID string, limit int,
) ([]domain.StatusEvent, error) {
	if afterID == "" {
		afterID = zeroUUID
	}
	rows, err := r.pool.Query(ctx,
		"SELECT "+statusEventColumns+" FROM application_status_events e"+
			" JOIN applications a ON a.user_id = e.user_id AND a.id = e.application_id"+
			" WHERE e.user_id = $1 AND e.id > $2 AND a.deleted_at IS NULL"+
			" ORDER BY e.id LIMIT $3",
		userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.StatusEvent, 0, limit)
	for rows.Next() {
		event, scanErr := scanStatusEvent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, event)
	}
	return result, rows.Err()
}
