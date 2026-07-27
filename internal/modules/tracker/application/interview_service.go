package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5"
)

// InterviewRepository persists interview rounds.
type InterviewRepository interface {
	Insert(ctx context.Context, tx pgx.Tx, round domain.InterviewRound) error
	FindDetail(ctx context.Context, userID, id string) (domain.InterviewRound, error)
	List(ctx context.Context, userID, appID string, filter ChildFilter) ([]domain.InterviewRound, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.InterviewRound, error)
	UpdateAggregate(ctx context.Context, tx pgx.Tx, round domain.InterviewRound) error
	SoftDelete(ctx context.Context, tx pgx.Tx, round domain.InterviewRound) error
	HydrateByIDs(ctx context.Context, userID string, ids []string) (map[string]domain.InterviewRound, error)
	BootstrapPage(ctx context.Context, userID, afterID string, limit int) ([]domain.InterviewRound, error)
	ApplicationExists(ctx context.Context, tx pgx.Tx, userID, appID string) (bool, error)
}

// InterviewService implements the interview round use cases.
type InterviewService struct {
	tx       TxRunner
	repo     InterviewRepository
	recorder Recorder
	idem     *idempotency.Store
	now      Clock
}

// NewInterviewService wires the interview service.
func NewInterviewService(
	tx TxRunner, repo InterviewRepository, recorder Recorder, idem *idempotency.Store, now Clock,
) *InterviewService {
	return &InterviewService{tx: tx, repo: repo, recorder: recorder, idem: idem, now: now}
}

// Get returns one interview round.
func (s *InterviewService) Get(
	ctx context.Context, userID, appID, id string,
) (domain.InterviewRound, error) {
	round, err := s.repo.FindDetail(ctx, userID, id)
	if err == nil && round.ApplicationID != appID {
		return domain.InterviewRound{}, domain.ErrNotFound
	}
	return round, err
}

// List returns a cursor page of interview rounds for one application.
func (s *InterviewService) List(
	ctx context.Context, userID, appID string, filter ChildFilter,
) ([]domain.InterviewRound, error) {
	return s.repo.List(ctx, userID, appID, filter)
}

// Create adds an interview round in its own transaction.
func (s *InterviewService) Create(
	ctx context.Context, userID, deviceID, appID string, write domain.InterviewWrite,
	command idempotency.Command,
) (domain.InterviewRound, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if write.ID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.InterviewRound{}, genErr
		}
		write.ID = generated.String()
	}
	record, err := s.idem.Reserve(ctx, tx, userID, "interview_round", write.ID, command, s.now())
	if err != nil {
		return domain.InterviewRound{}, err
	}
	if record.Replay {
		if err := tx.Commit(ctx); err != nil {
			return domain.InterviewRound{}, err
		}
		return s.repo.FindDetail(ctx, userID, record.ResourceID)
	}
	round, err := s.CreateInTx(ctx, tx, userID, deviceID, appID, write)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.InterviewRound{}, err
	}
	return round, nil
}

// CreateInTx adds an interview round inside a caller-owned transaction.
func (s *InterviewService) CreateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID, appID string, write domain.InterviewWrite,
) (domain.InterviewRound, error) {
	if err := write.Validate(); err != nil {
		return domain.InterviewRound{}, err
	}
	exists, err := s.repo.ApplicationExists(ctx, tx, userID, appID)
	if err != nil {
		return domain.InterviewRound{}, err
	}
	if !exists {
		return domain.InterviewRound{}, domain.ErrNotFound
	}
	roundID := write.ID
	if roundID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.InterviewRound{}, genErr
		}
		roundID = generated.String()
	}
	now := s.now()
	round := domain.InterviewRound{
		ID: roundID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef(deviceID), ApplicationID: appID,
		RoundNumber: write.RoundNumber, InterviewType: write.InterviewType,
		ScheduledAt: write.ScheduledAt, Timezone: write.Timezone,
		DurationMinutes: write.DurationMinutes, LocationOrLink: write.LocationOrLink,
		Interviewer: write.Interviewer, Status: write.Status,
	}
	if err := s.repo.Insert(ctx, tx, round); err != nil {
		return domain.InterviewRound{}, err
	}
	if err := s.recorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: roundID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.InterviewRound{}, err
	}
	return round, nil
}
