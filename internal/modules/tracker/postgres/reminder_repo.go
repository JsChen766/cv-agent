package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ReminderRepository loads and stores reminders.
type ReminderRepository struct {
	pool *pgxpool.Pool
}

// NewReminderRepository constructs a ReminderRepository.
func NewReminderRepository(pool *pgxpool.Pool) *ReminderRepository {
	return &ReminderRepository{pool: pool}
}

const reminderColumns = `
r.id, r.entity_version, r.created_at, r.updated_at, r.deleted_at,
r.last_modified_device_id, r.application_id, r.interview_round_id, r.title,
r.remind_at, r.status, r.delivered_at`

func scanReminder(row pgx.Row) (domain.Reminder, error) {
	var r domain.Reminder
	err := row.Scan(
		&r.ID, &r.EntityVersion, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt,
		&r.LastModifiedDeviceID, &r.ApplicationID, &r.InterviewRoundID, &r.Title,
		&r.RemindAt, &r.Status, &r.DeliveredAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Reminder{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Reminder{}, err
	}
	return r, nil
}

// ApplicationExists reports whether the user owns an active application.
func (r *ReminderRepository) ApplicationExists(
	ctx context.Context, tx pgx.Tx, userID, appID string,
) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM applications WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL)",
		userID, appID).Scan(&exists)
	return exists, err
}

// InterviewBelongsToApplication validates an optional aggregate child link.
func (r *ReminderRepository) InterviewBelongsToApplication(
	ctx context.Context, tx pgx.Tx, userID, appID, interviewID string,
) (bool, error) {
	return interviewBelongsToApplication(ctx, tx, userID, appID, interviewID)
}

const insertReminder = `
INSERT INTO reminders (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    application_id, interview_round_id, title, remind_at, status, delivered_at
) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11)`

// Insert writes a new reminder row.
func (r *ReminderRepository) Insert(ctx context.Context, tx pgx.Tx, m domain.Reminder) error {
	_, err := tx.Exec(ctx, insertReminder,
		m.ID, m.UserID, m.EntityVersion, m.CreatedAt, m.LastModifiedDeviceID,
		m.ApplicationID, m.InterviewRoundID, m.Title, m.RemindAt, string(m.Status),
		m.DeliveredAt,
	)
	return err
}

// FindDetail returns one active reminder.
func (r *ReminderRepository) FindDetail(ctx context.Context, userID, id string) (domain.Reminder, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+reminderColumns+" FROM reminders r WHERE r.user_id = $1 AND r.id = $2 AND r.deleted_at IS NULL",
		userID, id)
	return scanReminder(row)
}

// LoadForUpdate loads a reminder with a row lock.
func (r *ReminderRepository) LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.Reminder, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+reminderColumns+" FROM reminders r WHERE r.user_id = $1 AND r.id = $2 AND r.deleted_at IS NULL FOR UPDATE",
		userID, id)
	return scanReminder(row)
}

const updateReminder = `
UPDATE reminders SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    interview_round_id = $6, title = $7, remind_at = $8, status = $9, delivered_at = $10
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new reminder row under an optimistic lock.
func (r *ReminderRepository) UpdateAggregate(ctx context.Context, tx pgx.Tx, m domain.Reminder) error {
	tag, err := tx.Exec(ctx, updateReminder,
		m.UserID, m.ID, m.EntityVersion, m.UpdatedAt, m.LastModifiedDeviceID,
		m.InterviewRoundID, m.Title, m.RemindAt, string(m.Status), m.DeliveredAt,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

const softDeleteReminder = `
UPDATE reminders SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks a reminder deleted under an optimistic lock.
func (r *ReminderRepository) SoftDelete(ctx context.Context, tx pgx.Tx, m domain.Reminder) error {
	tag, err := tx.Exec(ctx, softDeleteReminder,
		m.UserID, m.ID, m.EntityVersion, m.DeletedAt, m.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

var _ application.ReminderRepository = (*ReminderRepository)(nil)
