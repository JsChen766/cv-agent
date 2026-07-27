package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const retention = 24 * time.Hour

var (
	// ErrKeyRequired reports a missing or oversized HTTP idempotency key.
	ErrKeyRequired = errors.New("idempotency key required")
	// ErrKeyReused reports the same key being reused for a different request.
	ErrKeyReused = errors.New("idempotency key reused")
)

// Command carries the stable identity of one direct HTTP create request.
type Command struct {
	Scope       string
	Key         string
	RequestHash string
}

// Record is the result of reserving one direct HTTP create operation.
type Record struct {
	ResourceID string
	Replay     bool
}

// Hash returns a deterministic SHA-256 hash of a decoded request DTO.
func Hash(value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

// Store atomically reserves and replays direct HTTP create requests.
type Store struct{}

// NewStore constructs the stateless PostgreSQL idempotency store.
func NewStore() *Store { return &Store{} }

// Reserve inserts a pending result in the caller transaction. A concurrent
// request with the same key waits for the first transaction and then replays
// its committed resource ID. Business creation and this row commit together.
func (s *Store) Reserve(
	ctx context.Context, tx pgx.Tx, userID, resourceType, resourceID string,
	command Command, now time.Time,
) (Record, error) {
	key := strings.TrimSpace(command.Key)
	if key == "" || len(key) > 160 || command.Scope == "" || command.RequestHash == "" {
		return Record{}, ErrKeyRequired
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO http_idempotency_records (
    user_id, scope, idempotency_key, request_hash, response_status,
    result_metadata, resource_type, resource_id, created_at, expires_at
) VALUES ($1, $2, $3, $4, 201, '{}', $5, $6, $7, $8)
ON CONFLICT (user_id, scope, idempotency_key) DO NOTHING`,
		userID, command.Scope, key, command.RequestHash, resourceType, resourceID,
		now, now.Add(retention),
	)
	if err != nil {
		return Record{}, err
	}
	if tag.RowsAffected() == 1 {
		return Record{ResourceID: resourceID}, nil
	}

	var storedHash, storedResourceID string
	err = tx.QueryRow(ctx, `
SELECT request_hash, resource_id::text
FROM http_idempotency_records
WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3`,
		userID, command.Scope, key,
	).Scan(&storedHash, &storedResourceID)
	if err != nil {
		return Record{}, err
	}
	if storedHash != command.RequestHash {
		return Record{}, ErrKeyReused
	}
	return Record{ResourceID: storedResourceID, Replay: true}, nil
}
