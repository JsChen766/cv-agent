package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// InterviewRepository loads and stores interview rounds.
type InterviewRepository struct {
	pool *pgxpool.Pool
}

// NewInterviewRepository constructs an InterviewRepository.
func NewInterviewRepository(pool *pgxpool.Pool) *InterviewRepository {
	return &InterviewRepository{pool: pool}
}

const interviewColumns = `
i.id, i.entity_version, i.created_at, i.updated_at, i.deleted_at,
i.last_modified_device_id, i.application_id, i.round_number, i.interview_type,
i.scheduled_at, i.timezone, i.duration_minutes, i.location_or_link,
i.interviewer, i.status`

func scanInterview(row pgx.Row) (domain.InterviewRound, error) {
	var i domain.InterviewRound
	var duration *int16
	var roundNumber int16
	err := row.Scan(
		&i.ID, &i.EntityVersion, &i.CreatedAt, &i.UpdatedAt, &i.DeletedAt,
		&i.LastModifiedDeviceID, &i.ApplicationID, &roundNumber, &i.InterviewType,
		&i.ScheduledAt, &i.Timezone, &duration, &i.LocationOrLink,
		&i.Interviewer, &i.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.InterviewRound{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.InterviewRound{}, err
	}
	i.RoundNumber = int(roundNumber)
	if duration != nil {
		value := int(*duration)
		i.DurationMinutes = &value
	}
	return i, nil
}

func durationArg(minutes *int) *int16 {
	if minutes == nil {
		return nil
	}
	value := int16(*minutes)
	return &value
}

// ApplicationExists reports whether the user owns an active application.
func (r *InterviewRepository) ApplicationExists(
	ctx context.Context, tx pgx.Tx, userID, appID string,
) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM applications WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL)",
		userID, appID).Scan(&exists)
	return exists, err
}

const insertInterview = `
INSERT INTO interview_rounds (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    application_id, round_number, interview_type, scheduled_at, timezone,
    duration_minutes, location_or_link, interviewer, status
) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

// Insert writes a new interview round row.
func (r *InterviewRepository) Insert(ctx context.Context, tx pgx.Tx, i domain.InterviewRound) error {
	_, err := tx.Exec(ctx, insertInterview,
		i.ID, i.UserID, i.EntityVersion, i.CreatedAt, i.LastModifiedDeviceID,
		i.ApplicationID, i.RoundNumber, string(i.InterviewType), i.ScheduledAt,
		i.Timezone, durationArg(i.DurationMinutes), i.LocationOrLink, i.Interviewer,
		string(i.Status),
	)
	return err
}

// FindDetail returns one active interview round.
func (r *InterviewRepository) FindDetail(ctx context.Context, userID, id string) (domain.InterviewRound, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+interviewColumns+" FROM interview_rounds i WHERE i.user_id = $1 AND i.id = $2 AND i.deleted_at IS NULL",
		userID, id)
	return scanInterview(row)
}

// LoadForUpdate loads an interview round with a row lock.
func (r *InterviewRepository) LoadForUpdate(
	ctx context.Context, tx pgx.Tx, userID, id string,
) (domain.InterviewRound, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+interviewColumns+" FROM interview_rounds i WHERE i.user_id = $1 AND i.id = $2 AND i.deleted_at IS NULL FOR UPDATE",
		userID, id)
	return scanInterview(row)
}

const updateInterview = `
UPDATE interview_rounds SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    round_number = $6, interview_type = $7, scheduled_at = $8, timezone = $9,
    duration_minutes = $10, location_or_link = $11, interviewer = $12, status = $13
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new interview round row under an optimistic lock.
func (r *InterviewRepository) UpdateAggregate(ctx context.Context, tx pgx.Tx, i domain.InterviewRound) error {
	tag, err := tx.Exec(ctx, updateInterview,
		i.UserID, i.ID, i.EntityVersion, i.UpdatedAt, i.LastModifiedDeviceID,
		i.RoundNumber, string(i.InterviewType), i.ScheduledAt, i.Timezone,
		durationArg(i.DurationMinutes), i.LocationOrLink, i.Interviewer, string(i.Status),
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

const softDeleteInterview = `
UPDATE interview_rounds SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks an interview round deleted under an optimistic lock.
func (r *InterviewRepository) SoftDelete(ctx context.Context, tx pgx.Tx, i domain.InterviewRound) error {
	tag, err := tx.Exec(ctx, softDeleteInterview,
		i.UserID, i.ID, i.EntityVersion, i.DeletedAt, i.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

var _ application.InterviewRepository = (*InterviewRepository)(nil)
