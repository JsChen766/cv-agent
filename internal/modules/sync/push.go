package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const operationRetention = 180 * 24 * time.Hour

type TxRunner interface {
	BeginTx(ctx context.Context) (pgx.Tx, error)
}

type PushService struct {
	tx       TxRunner
	ops      OperationRepository
	handlers map[EntityType]CommandHandler
	now      func() time.Time
}

func NewPushService(
	tx TxRunner,
	ops OperationRepository,
	handlers []CommandHandler,
	now func() time.Time,
) (*PushService, error) {
	registered := make(map[EntityType]CommandHandler, len(handlers))
	for _, handler := range handlers {
		entityType := handler.EntityType()
		if _, exists := registered[entityType]; exists {
			return nil, fmt.Errorf("duplicate sync command handler: %s", entityType)
		}
		registered[entityType] = handler
	}
	return &PushService{tx: tx, ops: ops, handlers: registered, now: now}, nil
}

func (s *PushService) Push(
	ctx context.Context,
	userID string,
	deviceID string,
	operations []PushOperation,
) PushResult {
	results := make([]OperationResult, 0, len(operations))
	for _, operation := range operations {
		results = append(results, s.applyOne(ctx, userID, deviceID, operation))
	}
	return PushResult{Results: results, ServerTime: s.now()}
}

func (s *PushService) applyOne(
	ctx context.Context,
	userID string,
	deviceID string,
	operation PushOperation,
) OperationResult {
	base := OperationResult{
		OperationID: operation.OperationID,
		EntityID:    operation.EntityID,
	}
	requestHash, err := hashOperation(operation)
	if err != nil {
		return retryable(base)
	}
	tx, err := s.tx.BeginTx(ctx)
	if err != nil {
		return retryable(base)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := s.ops.Lock(ctx, tx, userID, operation.OperationID); err != nil {
		return retryable(base)
	}
	stored, err := s.ops.Find(ctx, tx, userID, operation.OperationID)
	if err != nil {
		return retryable(base)
	}
	if stored != nil {
		return replay(base, requestHash, *stored)
	}

	command := Command{
		UserID: userID, DeviceID: deviceID, PushOperation: operation,
	}
	handler, ok := s.handlers[operation.EntityType]
	result := ApplyResult{}
	if !ok {
		result = failed(ResultValidationFailed, "sync_entity_not_available")
	} else {
		result, err = handler.Apply(ctx, tx, command)
		if err != nil {
			return retryable(base)
		}
	}
	if result.Status == ResultRetryableError || result.Status == ResultAlreadyApplied {
		return retryable(base)
	}
	now := s.now()
	if err := s.ops.Save(
		ctx, tx, command, requestHash, result, now, now.Add(operationRetention),
	); err != nil {
		return retryable(base)
	}
	if err := tx.Commit(ctx); err != nil {
		return retryable(base)
	}
	return fromApply(base, result)
}

func hashOperation(operation PushOperation) (string, error) {
	var payload any
	decoder := json.NewDecoder(bytes.NewReader(operation.Payload))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(struct {
		OperationID     string     `json:"operationId"`
		EntityType      EntityType `json:"entityType"`
		EntityID        string     `json:"entityId"`
		Action          Action     `json:"action"`
		ExpectedVersion *int64     `json:"expectedVersion"`
		Payload         any        `json:"payload"`
	}{
		operation.OperationID, operation.EntityType, operation.EntityID,
		operation.Action, operation.ExpectedVersion, payload,
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func replay(
	base OperationResult,
	requestHash string,
	stored StoredOperation,
) OperationResult {
	if !bytes.Equal([]byte(requestHash), []byte(stored.RequestHash)) {
		return fromApply(base, failed(ResultConflict, "idempotency_key_reused"))
	}
	status := stored.Status
	if status == ResultApplied {
		status = ResultAlreadyApplied
	}
	return fromApply(base, ApplyResult{
		Status: status, AppliedVersion: stored.AppliedVersion,
		ErrorCode: stored.ErrorCode,
	})
}

func failed(status ResultStatus, code string) ApplyResult {
	return ApplyResult{Status: status, ErrorCode: code}
}

func fromApply(base OperationResult, applied ApplyResult) OperationResult {
	base.Status = applied.Status
	base.AppliedVersion = applied.AppliedVersion
	base.ServerEntity = applied.ServerEntity
	if applied.ErrorCode != "" {
		base.ErrorCode = &applied.ErrorCode
	}
	return base
}

func retryable(base OperationResult) OperationResult {
	code := "sync_retryable_error"
	base.Status = ResultRetryableError
	base.ErrorCode = &code
	return base
}
