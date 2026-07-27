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

type reminderCommand struct {
	ApplicationID    string     `json:"applicationId"`
	InterviewRoundID *string    `json:"interviewRoundId"`
	Title            string     `json:"title"`
	RemindAt         *time.Time `json:"remindAt"`
	Status           string     `json:"status"`
	DeliveredAt      *time.Time `json:"deliveredAt"`
}

func (c reminderCommand) toDomain(expectedVersion *int64) domain.ReminderWrite {
	write := domain.ReminderWrite{
		ExpectedVersion: expectedVersion, ApplicationID: c.ApplicationID,
		InterviewRoundID: c.InterviewRoundID, Title: c.Title,
		Status: domain.ReminderStatus(c.Status), DeliveredAt: utcPtr(c.DeliveredAt),
	}
	if c.RemindAt != nil {
		write.RemindAt = c.RemindAt.UTC()
	}
	return write
}

// ReminderCommandHandler applies reminder push commands.
type ReminderCommandHandler struct {
	service *application.ReminderService
}

// NewReminderCommandHandler wires the handler.
func NewReminderCommandHandler(service *application.ReminderService) *ReminderCommandHandler {
	return &ReminderCommandHandler{service: service}
}

// EntityType identifies reminders on the command feed.
func (h *ReminderCommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeReminder
}

// Apply routes a push command to the matching reminder use case.
func (h *ReminderCommandHandler) Apply(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	switch command.Action {
	case syncmod.ActionCreate:
		var request reminderCommand
		if err := decodePayload(command.Payload, &request); err != nil {
			return failure(syncmod.ResultValidationFailed, "invalid_reminder"), nil
		}
		write := request.toDomain(nil)
		write.ID = command.EntityID
		reminder, err := h.service.CreateInTx(ctx, tx, command.UserID, command.DeviceID, write)
		return reminderResult(reminder, err)
	case syncmod.ActionUpdate:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		var request reminderCommand
		if err := decodePayload(command.Payload, &request); err != nil {
			return failure(syncmod.ResultValidationFailed, "invalid_reminder"), nil
		}
		reminder, err := h.service.ReplaceInTx(
			ctx, tx, command.UserID, command.DeviceID, command.EntityID,
			request.toDomain(command.ExpectedVersion),
		)
		return reminderResult(reminder, err)
	case syncmod.ActionDelete:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		reminder, err := h.service.DeleteInTx(
			ctx, tx, command.UserID, command.DeviceID, command.EntityID, *command.ExpectedVersion,
		)
		return reminderResult(reminder, err)
	default:
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
}

func reminderResult(reminder domain.Reminder, err error) (syncmod.ApplyResult, error) {
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrNotFound):
			return failure(syncmod.ResultValidationFailed, "reminder_not_found"), nil
		case errors.Is(err, domain.ErrInvalidInput):
			return failure(syncmod.ResultValidationFailed, "invalid_reminder"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	return applied(reminder.EntityVersion, reminderPayloadOf(reminder)), nil
}
