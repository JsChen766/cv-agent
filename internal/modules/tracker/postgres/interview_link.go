package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
)

func interviewBelongsToApplication(
	ctx context.Context, tx pgx.Tx, userID, appID, interviewID string,
) (bool, error) {
	var belongs bool
	err := tx.QueryRow(ctx, `
SELECT EXISTS(
    SELECT 1 FROM interview_rounds
    WHERE user_id = $1 AND application_id = $2 AND id = $3 AND deleted_at IS NULL
)`, userID, appID, interviewID).Scan(&belongs)
	return belongs, err
}
