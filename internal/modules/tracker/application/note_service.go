package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5"
)

// NoteRepository persists application notes.
type NoteRepository interface {
	Insert(ctx context.Context, tx pgx.Tx, note domain.Note) error
	FindDetail(ctx context.Context, userID, id string) (domain.Note, error)
	List(ctx context.Context, userID, appID string, filter ChildFilter) ([]domain.Note, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.Note, error)
	UpdateAggregate(ctx context.Context, tx pgx.Tx, note domain.Note) error
	SoftDelete(ctx context.Context, tx pgx.Tx, note domain.Note) error
	HydrateByIDs(ctx context.Context, userID string, ids []string) (map[string]domain.Note, error)
	BootstrapPage(ctx context.Context, userID, afterID string, limit int) ([]domain.Note, error)
	ApplicationExists(ctx context.Context, tx pgx.Tx, userID, appID string) (bool, error)
	InterviewBelongsToApplication(ctx context.Context, tx pgx.Tx, userID, appID, interviewID string) (bool, error)
}

// NoteService implements the application note use cases.
type NoteService struct {
	tx       TxRunner
	repo     NoteRepository
	recorder Recorder
	idem     *idempotency.Store
	now      Clock
}

// NewNoteService wires the note service.
func NewNoteService(
	tx TxRunner, repo NoteRepository, recorder Recorder, idem *idempotency.Store, now Clock,
) *NoteService {
	return &NoteService{tx: tx, repo: repo, recorder: recorder, idem: idem, now: now}
}

// Get returns one note.
func (s *NoteService) Get(ctx context.Context, userID, appID, id string) (domain.Note, error) {
	note, err := s.repo.FindDetail(ctx, userID, id)
	if err == nil && note.ApplicationID != appID {
		return domain.Note{}, domain.ErrNotFound
	}
	return note, err
}

// List returns a cursor page of notes for one application.
func (s *NoteService) List(
	ctx context.Context, userID, appID string, filter ChildFilter,
) ([]domain.Note, error) {
	return s.repo.List(ctx, userID, appID, filter)
}

// Create adds a note in its own transaction.
func (s *NoteService) Create(
	ctx context.Context, userID, deviceID, appID string, write domain.NoteWrite,
	command idempotency.Command,
) (domain.Note, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Note{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if write.ID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.Note{}, genErr
		}
		write.ID = generated.String()
	}
	record, err := s.idem.Reserve(ctx, tx, userID, "application_note", write.ID, command, s.now())
	if err != nil {
		return domain.Note{}, err
	}
	if record.Replay {
		if err := tx.Commit(ctx); err != nil {
			return domain.Note{}, err
		}
		return s.repo.FindDetail(ctx, userID, record.ResourceID)
	}
	note, err := s.CreateInTx(ctx, tx, userID, deviceID, appID, write)
	if err != nil {
		return domain.Note{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Note{}, err
	}
	return note, nil
}

// CreateInTx adds a note inside a caller-owned transaction.
func (s *NoteService) CreateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, appID string, write domain.NoteWrite,
) (domain.Note, error) {
	if err := write.Validate(); err != nil {
		return domain.Note{}, err
	}
	exists, err := s.repo.ApplicationExists(ctx, tx, userID, appID)
	if err != nil {
		return domain.Note{}, err
	}
	if !exists {
		return domain.Note{}, domain.ErrNotFound
	}
	if err := validateInterviewLink(ctx, tx, s.repo, userID, appID, write.InterviewRoundID); err != nil {
		return domain.Note{}, err
	}
	noteID := write.ID
	if noteID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.Note{}, genErr
		}
		noteID = generated.String()
	}
	now := s.now()
	note := domain.Note{
		ID: noteID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef(deviceID), ApplicationID: appID,
		InterviewRoundID: write.InterviewRoundID, NoteType: write.NoteType,
		Content: write.Content,
	}
	if err := s.repo.Insert(ctx, tx, note); err != nil {
		return domain.Note{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: noteID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.Note{}, err
	}
	return note, nil
}
