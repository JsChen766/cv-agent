package syncadapter

import (
	"context"
	"errors"
	"time"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

type interviewCommand struct {
	ApplicationID   string     `json:"applicationId"`
	RoundNumber     int        `json:"roundNumber"`
	InterviewType   string     `json:"interviewType"`
	ScheduledAt     *time.Time `json:"scheduledAt"`
	Timezone        string     `json:"timezone"`
	DurationMinutes *int       `json:"durationMinutes"`
	LocationOrLink  *string    `json:"locationOrLink"`
	Interviewer     *string    `json:"interviewer"`
	Status          string     `json:"status"`
}

func (c interviewCommand) toDomain(expectedVersion *int64) domain.InterviewWrite {
	return domain.InterviewWrite{
		ExpectedVersion: expectedVersion, RoundNumber: c.RoundNumber,
		InterviewType: domain.InterviewType(c.InterviewType),
		ScheduledAt:   utcPtr(c.ScheduledAt), Timezone: c.Timezone,
		DurationMinutes: c.DurationMinutes, LocationOrLink: c.LocationOrLink,
		Interviewer: c.Interviewer, Status: domain.InterviewStatus(c.Status),
	}
}

// InterviewCommandHandler applies interview-round push commands.
type InterviewCommandHandler struct {
	service *application.InterviewService
}

// NewInterviewCommandHandler wires the handler.
func NewInterviewCommandHandler(service *application.InterviewService) *InterviewCommandHandler {
	return &InterviewCommandHandler{service: service}
}

// EntityType identifies interview rounds on the command feed.
func (h *InterviewCommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeInterviewRound
}

// Apply routes a push command to the matching interview use case.
func (h *InterviewCommandHandler) Apply(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	switch command.Action {
	case syncmod.ActionCreate:
		var request interviewCommand
		if err := decodePayload(command.Payload, &request); err != nil {
			return failure(syncmod.ResultValidationFailed, "invalid_interview"), nil
		}
		write := request.toDomain(nil)
		write.ID = command.EntityID
		round, err := h.service.CreateInTx(
			ctx, tx, command.UserID, command.DeviceID, request.ApplicationID, write,
		)
		return interviewResult(round, err)
	case syncmod.ActionUpdate:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		var request interviewCommand
		if err := decodePayload(command.Payload, &request); err != nil {
			return failure(syncmod.ResultValidationFailed, "invalid_interview"), nil
		}
		round, err := h.service.ReplaceInTx(
			ctx, tx, command.UserID, command.DeviceID, command.EntityID,
			request.toDomain(command.ExpectedVersion),
		)
		return interviewResult(round, err)
	case syncmod.ActionDelete:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		round, err := h.service.DeleteInTx(
			ctx, tx, command.UserID, command.DeviceID, command.EntityID, *command.ExpectedVersion,
		)
		return interviewResult(round, err)
	default:
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
}

func interviewResult(round domain.InterviewRound, err error) (syncmod.ApplyResult, error) {
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrRoundConflict):
			return failure(syncmod.ResultConflict, "interview_round_conflict"), nil
		case errors.Is(err, domain.ErrNotFound):
			return failure(syncmod.ResultValidationFailed, "interview_not_found"), nil
		case errors.Is(err, domain.ErrInvalidInput):
			return failure(syncmod.ResultValidationFailed, "invalid_interview"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	return applied(round.EntityVersion, interviewPayloadOf(round)), nil
}
