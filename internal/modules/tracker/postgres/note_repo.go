package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NoteRepository loads and stores application notes.
type NoteRepository struct {
	pool *pgxpool.Pool
}

// NewNoteRepository constructs a NoteRepository.
func NewNoteRepository(pool *pgxpool.Pool) *NoteRepository {
	return &NoteRepository{pool: pool}
}

const noteColumns = `
n.id, n.entity_version, n.created_at, n.updated_at, n.deleted_at,
n.last_modified_device_id, n.application_id, n.interview_round_id, n.note_type,
n.content`

func scanNote(row pgx.Row) (domain.Note, error) {
	var n domain.Note
	err := row.Scan(
		&n.ID, &n.EntityVersion, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt,
		&n.LastModifiedDeviceID, &n.ApplicationID, &n.InterviewRoundID, &n.NoteType,
		&n.Content,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Note{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Note{}, err
	}
	return n, nil
}

// ApplicationExists reports whether the user owns an active application.
func (r *NoteRepository) ApplicationExists(
	ctx context.Context, tx pgx.Tx, userID, appID string,
) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM applications WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL)",
		userID, appID).Scan(&exists)
	return exists, err
}

// InterviewBelongsToApplication validates an optional aggregate child link.
func (r *NoteRepository) InterviewBelongsToApplication(
	ctx context.Context, tx pgx.Tx, userID, appID, interviewID string,
) (bool, error) {
	return interviewBelongsToApplication(ctx, tx, userID, appID, interviewID)
}

const insertNote = `
INSERT INTO application_notes (
    id, user_id, entity_version, created_at, updated_at, last_modified_device_id,
    application_id, interview_round_id, note_type, content
) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)`

// Insert writes a new note row.
func (r *NoteRepository) Insert(ctx context.Context, tx pgx.Tx, n domain.Note) error {
	_, err := tx.Exec(ctx, insertNote,
		n.ID, n.UserID, n.EntityVersion, n.CreatedAt, n.LastModifiedDeviceID,
		n.ApplicationID, n.InterviewRoundID, string(n.NoteType), n.Content,
	)
	return err
}

// FindDetail returns one active note.
func (r *NoteRepository) FindDetail(ctx context.Context, userID, id string) (domain.Note, error) {
	row := r.pool.QueryRow(ctx,
		"SELECT "+noteColumns+" FROM application_notes n WHERE n.user_id = $1 AND n.id = $2 AND n.deleted_at IS NULL",
		userID, id)
	return scanNote(row)
}

// LoadForUpdate loads a note with a row lock.
func (r *NoteRepository) LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.Note, error) {
	row := tx.QueryRow(ctx,
		"SELECT "+noteColumns+" FROM application_notes n WHERE n.user_id = $1 AND n.id = $2 AND n.deleted_at IS NULL FOR UPDATE",
		userID, id)
	return scanNote(row)
}

const updateNote = `
UPDATE application_notes SET
    entity_version = $3, updated_at = $4, last_modified_device_id = $5,
    interview_round_id = $6, note_type = $7, content = $8
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// UpdateAggregate applies a new note row under an optimistic lock.
func (r *NoteRepository) UpdateAggregate(ctx context.Context, tx pgx.Tx, n domain.Note) error {
	tag, err := tx.Exec(ctx, updateNote,
		n.UserID, n.ID, n.EntityVersion, n.UpdatedAt, n.LastModifiedDeviceID,
		n.InterviewRoundID, string(n.NoteType), n.Content,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

const softDeleteNote = `
UPDATE application_notes SET
    entity_version = $3, updated_at = $4, deleted_at = $4, last_modified_device_id = $5
WHERE user_id = $1 AND id = $2 AND entity_version = $3 - 1 AND deleted_at IS NULL`

// SoftDelete marks a note deleted under an optimistic lock.
func (r *NoteRepository) SoftDelete(ctx context.Context, tx pgx.Tx, n domain.Note) error {
	tag, err := tx.Exec(ctx, softDeleteNote,
		n.UserID, n.ID, n.EntityVersion, n.DeletedAt, n.LastModifiedDeviceID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

var _ application.NoteRepository = (*NoteRepository)(nil)
