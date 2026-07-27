package postgres

import (
	"context"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ChangeRepository struct {
	pool *pgxpool.Pool
}

func NewChangeRepository(pool *pgxpool.Pool) *ChangeRepository {
	return &ChangeRepository{pool: pool}
}

const listChanges = `
SELECT change_seq, entity_type, entity_id, entity_version, operation, changed_at
FROM sync_changes
WHERE user_id = $1 AND change_seq > $2
ORDER BY change_seq
LIMIT $3`

func (r *ChangeRepository) ListAfter(
	ctx context.Context,
	userID string,
	sequence int64,
	limit int,
) ([]syncmod.ChangeKey, error) {
	rows, err := r.pool.Query(ctx, listChanges, userID, sequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	changes := make([]syncmod.ChangeKey, 0, limit)
	for rows.Next() {
		var change syncmod.ChangeKey
		if err := rows.Scan(
			&change.Sequence, &change.EntityType, &change.EntityID,
			&change.EntityVersion, &change.Operation, &change.ChangedAt,
		); err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, rows.Err()
}

func (r *ChangeRepository) HighWatermark(
	ctx context.Context,
	userID string,
) (int64, error) {
	var watermark int64
	err := r.pool.QueryRow(
		ctx,
		"SELECT COALESCE(MAX(change_seq), 0) FROM sync_changes WHERE user_id = $1",
		userID,
	).Scan(&watermark)
	return watermark, err
}
