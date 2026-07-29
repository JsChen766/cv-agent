package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"

	"github.com/jackc/pgx/v5"
)

// ApplicationRepository persists tracker applications and their status events.
type ApplicationRepository interface {
	Insert(ctx context.Context, tx pgx.Tx, app domain.Application) error
	FindDetail(ctx context.Context, userID, id string) (domain.Application, error)
	List(ctx context.Context, userID string, filter ApplicationFilter) ([]domain.Application, error)
	LoadForUpdate(ctx context.Context, tx pgx.Tx, userID, id string) (domain.Application, error)
	UpdateAggregate(ctx context.Context, tx pgx.Tx, app domain.Application) error
	SoftDelete(ctx context.Context, tx pgx.Tx, app domain.Application) error
	LockOperation(ctx context.Context, tx pgx.Tx, userID, operationID string) error
	InsertStatusEvent(ctx context.Context, tx pgx.Tx, event domain.StatusEvent) error
	FindStatusEventByOperation(ctx context.Context, tx pgx.Tx, userID, operationID string) (domain.StatusEvent, error)
	ListStatusEvents(ctx context.Context, userID, appID string, filter ChildFilter) ([]domain.StatusEvent, error)
	HydrateByIDs(ctx context.Context, userID string, ids []string) (map[string]domain.Application, error)
	HydrateStatusEvents(ctx context.Context, userID string, ids []string) (map[string]domain.StatusEvent, error)
	BootstrapPage(ctx context.Context, userID, afterID string, limit int) ([]domain.Application, error)
	BootstrapEvents(ctx context.Context, userID, afterID string, limit int) ([]domain.StatusEvent, error)
}

// ApplicationService implements the Application use cases.
type ApplicationService struct {
	tx                TxRunner
	repo              ApplicationRepository
	cascade           ApplicationCascadeRepository
	appRecorder       Recorder
	eventRecorder     Recorder
	interviewRecorder Recorder
	noteRecorder      Recorder
	reminderRecorder  Recorder
	jdTitles          AssetTitleLookup
	resumeTitles      AssetTitleLookup
	idem              *idempotency.Store
	now               Clock
}

// NewApplicationService wires the application service.
func NewApplicationService(
	tx TxRunner, repo ApplicationRepository, cascade ApplicationCascadeRepository,
	appRecorder, eventRecorder, interviewRecorder, noteRecorder, reminderRecorder Recorder,
	jdTitles, resumeTitles AssetTitleLookup,
	idem *idempotency.Store,
	now Clock,
) *ApplicationService {
	return &ApplicationService{
		tx: tx, repo: repo, cascade: cascade, appRecorder: appRecorder,
		eventRecorder: eventRecorder, interviewRecorder: interviewRecorder,
		noteRecorder: noteRecorder, reminderRecorder: reminderRecorder, now: now,
		jdTitles: jdTitles, resumeTitles: resumeTitles,
		idem: idem,
	}
}

// Get returns one application.
func (s *ApplicationService) Get(ctx context.Context, userID, id string) (domain.Application, error) {
	return s.repo.FindDetail(ctx, userID, id)
}

// List returns a cursor page of applications.
func (s *ApplicationService) List(
	ctx context.Context, userID string, filter ApplicationFilter,
) ([]domain.Application, error) {
	return s.repo.List(ctx, userID, filter)
}

// ListStatusEvents returns immutable status events for one application.
func (s *ApplicationService) ListStatusEvents(
	ctx context.Context, userID, appID string, filter ChildFilter,
) ([]domain.StatusEvent, error) {
	if _, err := s.repo.FindDetail(ctx, userID, appID); err != nil {
		return nil, err
	}
	return s.repo.ListStatusEvents(ctx, userID, appID, filter)
}

// Create records a new application in its own transaction.
func (s *ApplicationService) Create(
	ctx context.Context, userID, deviceID string, input domain.Create, command idempotency.Command,
) (domain.Application, error) {
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return domain.Application{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if input.ID == "" {
		generated, genErr := id.NewV7()
		if genErr != nil {
			return domain.Application{}, genErr
		}
		input.ID = generated.String()
	}
	record, err := s.idem.Reserve(ctx, tx, userID, "application", input.ID, command, s.now())
	if err != nil {
		return domain.Application{}, err
	}
	if record.Replay {
		if err := tx.Commit(ctx); err != nil {
			return domain.Application{}, err
		}
		return s.repo.FindDetail(ctx, userID, record.ResourceID)
	}
	app, err := s.CreateInTx(ctx, tx, userID, deviceID, input)
	if err != nil {
		return domain.Application{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Application{}, err
	}
	return app, nil
}

// CreateInTx records a new application inside a caller-owned transaction. New
// records start in the applied status and never write an initial status event.
// The caller may supply the entity ID for idempotent offline creation.
func (s *ApplicationService) CreateInTx(
	ctx context.Context, tx pgx.Tx, userID, deviceID string, input domain.Create,
) (domain.Application, error) {
	if err := input.Validate(); err != nil {
		return domain.Application{}, err
	}
	jdSnapshot, err := resolveTitle(ctx, s.jdTitles, userID, input.JdID)
	if err != nil {
		return domain.Application{}, err
	}
	resumeSnapshot, err := resolveTitle(ctx, s.resumeTitles, userID, input.ResumeID)
	if err != nil {
		return domain.Application{}, err
	}
	appID := input.ID
	if appID == "" {
		generated, err := id.NewV7()
		if err != nil {
			return domain.Application{}, err
		}
		appID = generated.String()
	}
	now := s.now()
	app := domain.Application{
		ID: appID, UserID: userID, EntityVersion: 1, CreatedAt: now, UpdatedAt: now,
		LastModifiedDeviceID: deviceRef(deviceID), JdID: input.JdID, ResumeID: input.ResumeID,
		CompanyName: input.CompanyName, RoleName: input.RoleName,
		JdTitleSnapshot: input.JdTitleSnapshot, ResumeTitleSnapshot: input.ResumeTitleSnapshot,
		ResumeContentHashSnapshot: input.ResumeContentHashSnapshot,
		DeliveryMethod:            input.DeliveryMethod, TargetURL: input.TargetURL,
		AppliedAt: input.AppliedAt, Status: domain.StatusApplied,
		PendingConfirmation: input.PendingConfirmation, Source: input.Source,
		DedupeKey: input.DedupeKey, CompanyBusiness: input.CompanyBusiness,
		RoleSummary: input.RoleSummary, CompanyCulture: input.CompanyCulture,
	}
	if input.JdID != nil {
		app.JdTitleSnapshot = jdSnapshot
	}
	if input.ResumeID != nil {
		app.ResumeTitleSnapshot = resumeSnapshot
	}
	if err := s.repo.Insert(ctx, tx, app); err != nil {
		return domain.Application{}, err
	}
	if err := s.appRecorder.Record(ctx, tx, SyncChange{
		UserID: userID, EntityID: appID, EntityVersion: 1, ChangedAt: now,
	}); err != nil {
		return domain.Application{}, err
	}
	return app, nil
}
