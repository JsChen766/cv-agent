package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
)

type OperationRepository struct{}

func NewOperationRepository() *OperationRepository {
	return &OperationRepository{}
}

func (r *OperationRepository) Lock(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	operationID string,
) error {
	lockKey := userID + "/" + operationID
	_, err := tx.Exec(
		ctx,
		"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
		lockKey,
	)
	return err
}

const findOperation = `
SELECT request_hash, result_status, entity_id, applied_version,
       COALESCE(result_metadata->>'errorCode', '')
FROM sync_operations
WHERE user_id = $1 AND operation_id = $2`

func (r *OperationRepository) Find(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	operationID string,
) (*syncmod.StoredOperation, error) {
	var stored syncmod.StoredOperation
	err := tx.QueryRow(ctx, findOperation, userID, operationID).Scan(
		&stored.RequestHash, &stored.Status, &stored.EntityID,
		&stored.AppliedVersion, &stored.ErrorCode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &stored, nil
}

const saveOperation = `
INSERT INTO sync_operations (
    user_id, operation_id, device_id, entity_type, entity_id, action,
    request_hash, result_status, applied_version, result_metadata,
    created_at, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`

func (r *OperationRepository) Save(
	ctx context.Context,
	tx pgx.Tx,
	command syncmod.Command,
	requestHash string,
	result syncmod.ApplyResult,
	createdAt time.Time,
	expiresAt time.Time,
) error {
	metadata := map[string]string{}
	if result.ErrorCode != "" {
		metadata["errorCode"] = result.ErrorCode
	}
	encodedMetadata, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		ctx, saveOperation,
		command.UserID, command.OperationID, command.DeviceID,
		command.EntityType, command.EntityID, command.Action,
		requestHash, result.Status, result.AppliedVersion, encodedMetadata,
		createdAt, expiresAt,
	)
	return err
}
