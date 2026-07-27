package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

type interviewLinkRepository interface {
	InterviewBelongsToApplication(
		ctx context.Context, tx pgx.Tx, userID, appID, interviewID string,
	) (bool, error)
}

func validateInterviewLink(
	ctx context.Context, tx pgx.Tx, repo interviewLinkRepository,
	userID, appID string, interviewID *string,
) error {
	if interviewID == nil {
		return nil
	}
	belongs, err := repo.InterviewBelongsToApplication(ctx, tx, userID, appID, *interviewID)
	if err != nil {
		return err
	}
	if !belongs {
		return domain.ErrInvalidInput
	}
	return nil
}
