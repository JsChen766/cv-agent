package sync

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

type Action string

const (
	ActionCreate     Action = "create"
	ActionUpdate     Action = "update"
	ActionDelete     Action = "delete"
	ActionTransition Action = "transition"
)

type PushOperation struct {
	OperationID     string
	EntityType      EntityType
	EntityID        string
	Action          Action
	ExpectedVersion *int64
	Payload         json.RawMessage
}

type Command struct {
	UserID   string
	DeviceID string
	PushOperation
}

type ResultStatus string

const (
	ResultApplied          ResultStatus = "applied"
	ResultAlreadyApplied   ResultStatus = "already_applied"
	ResultConflict         ResultStatus = "conflict"
	ResultValidationFailed ResultStatus = "validation_failed"
	ResultForbidden        ResultStatus = "forbidden"
	ResultRetryableError   ResultStatus = "retryable_error"
)

type OperationResult struct {
	OperationID    string
	Status         ResultStatus
	EntityID       string
	AppliedVersion *int64
	ErrorCode      *string
	ServerEntity   any
}

type PushResult struct {
	Results    []OperationResult
	ServerTime time.Time
}

type ApplyResult struct {
	Status         ResultStatus
	AppliedVersion *int64
	ErrorCode      string
	ServerEntity   any
}

// CommandHandler belongs to an owning business module and applies one command
// inside the transaction controlled by Sync Push.
type CommandHandler interface {
	EntityType() EntityType
	Apply(ctx context.Context, tx pgx.Tx, command Command) (ApplyResult, error)
}

type StoredOperation struct {
	RequestHash    string
	Status         ResultStatus
	EntityID       string
	AppliedVersion *int64
	ErrorCode      string
	ServerEntity   any
}

type OperationRepository interface {
	Lock(ctx context.Context, tx pgx.Tx, userID, operationID string) error
	Find(
		ctx context.Context,
		tx pgx.Tx,
		userID string,
		operationID string,
	) (*StoredOperation, error)
	Save(
		ctx context.Context,
		tx pgx.Tx,
		command Command,
		requestHash string,
		result ApplyResult,
		createdAt time.Time,
		expiresAt time.Time,
	) error
}
