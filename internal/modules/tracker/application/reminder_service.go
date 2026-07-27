package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5"
)

// ReminderRepository persists reminders.
type ReminderRepository interface {
	Insert(ctx context.Context, tx pgx.Tx, reminder domain.Reminder) error
	FindDetail(ctx context.Context, userID, id string) (domain.Reminder, error)
	List(ctx context.Context, userID string, filter ReminderFilter) ([]domain.Reminder, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.Reminder, error)
	UpdateAggregate(ctx context.Context, tx pgx.Tx, reminder domain.Reminder) error
	SoftDelete(ctx context.Context, tx pgx.Tx, reminder domain.Reminder) error
	HydrateByIDs(ctx context.Context, userID string, ids []string) (map[string]domain.Reminder, error)
	BootstrapPage(ctx context.Context, userID, afterID string, limit int) ([]domain.Reminder, error)
	ApplicationExists(ctx context.Context, tx pgx.Tx, userID, appID string) (bool, error)
	InterviewBelongsToApplication(ctx context.Context, tx pgx.Tx, userID, appID, interviewID string) (bool, error)
}

// ReminderService implements the reminder use cases.
type ReminderService struct {
	tx       TxRunner
	repo     ReminderRepository
	recorder Recorder
	idem     *idempotency.Store
	now      Clock
}

// NewReminderService wires the reminder service.
func NewReminderService(
	tx TxRunner, repo ReminderRepository, recorder Recorder, idem *idempotency.Store, now Clock,
) *ReminderService {
	return &ReminderService{tx: tx, repo: repo, recorder: recorder, idem: idem, now: now}
}

// Get returns one reminder.
func (s *ReminderService) Get(ctx context.Context, userID, id string) (domain.Reminder, error) {
	return s.repo.FindDetail(ctx, userID, id)
}

// List returns a cursor page of reminders.
func (s *ReminderService) List(
	ctx context.Context, userID string, filter ReminderFilter,
) ([]domain.Reminder, error) {
	return s.repo.List(ctx, userID, filter)
}

// Create adds a reminder in its own transaction.
func (s *ReminderService) Create(
	ctx context.Context, userID, deviceID string, write domain.ReminderWrite,
	command idempotency.Command,
) (domain.Reminder, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Reminder{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if write.ID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.Reminder{}, genErr
		}
		write.ID = generated.String()
	}
	record, err := s.idem.Reserve(ctx, tx, userID, "reminder", write.ID, command, s.now())
	if err != nil {
		return domain.Reminder{}, err
	}
	if record.Replay {
		if err := tx.Commit(ctx); err != nil {
			return domain.Reminder{}, err
		}
		return s.repo.FindDetail(ctx, userID, record.ResourceID)
	}
	reminder, err := s.CreateInTx(ctx, tx, userID, deviceID, write)
	if err != nil {
		return domain.Reminder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Reminder{}, err
	}
	return reminder, nil
}

// CreateInTx adds a reminder inside a caller-owned transaction.
func (s *ReminderService) CreateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID string, write domain.ReminderWrite,
) (domain.Reminder, error) {
	if err := write.Validate(); err != nil {
		return domain.Reminder{}, err
	}
	if write.ApplicationID == "" {
		return domain.Reminder{}, domain.ErrInvalidInput
	}
	exists, err := s.repo.ApplicationExists(ctx, tx, userID, write.ApplicationID)
	if err != nil {
		return domain.Reminder{}, err
	}
	if !exists {
		return domain.Reminder{}, domain.ErrNotFound
	}
	if err := validateInterviewLink(
		ctx, tx, s.repo, userID, write.ApplicationID, write.InterviewRoundID,
	); err != nil {
		return domain.Reminder{}, err
	}
	reminderID := write.ID
	if reminderID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.Reminder{}, genErr
		}
		reminderID = generated.String()
	}
	now := s.now()
	reminder := domain.Reminder{
		ID: reminderID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef(deviceID), ApplicationID: write.ApplicationID,
		InterviewRoundID: write.InterviewRoundID, Title: write.Title,
		RemindAt: write.RemindAt, Status: write.Status, DeliveredAt: write.DeliveredAt,
	}
	if err := s.repo.Insert(ctx, tx, reminder); err != nil {
		return domain.Reminder{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: reminderID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.Reminder{}, err
	}
	return reminder, nil
}
