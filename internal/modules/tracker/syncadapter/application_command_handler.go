package syncadapter

import (
	"context"
	"errors"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

// ApplicationCommandHandler applies application push commands, including the
// transition action that atomically writes the status event.
type ApplicationCommandHandler struct {
	service *application.ApplicationService
}

// NewApplicationCommandHandler wires the handler.
func NewApplicationCommandHandler(service *application.ApplicationService) *ApplicationCommandHandler {
	return &ApplicationCommandHandler{service: service}
}

// EntityType identifies applications on the command feed.
func (h *ApplicationCommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeApplication
}

// Apply routes a push command to the matching application use case.
func (h *ApplicationCommandHandler) Apply(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	switch command.Action {
	case syncmod.ActionCreate:
		return h.applyCreate(ctx, tx, command)
	case syncmod.ActionUpdate:
		return h.applyUpdate(ctx, tx, command)
	case syncmod.ActionTransition:
		return h.applyTransition(ctx, tx, command)
	case syncmod.ActionDelete:
		return h.applyDelete(ctx, tx, command)
	default:
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
}

func (h *ApplicationCommandHandler) applyCreate(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	var request applicationCreateCommand
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_application"), nil
	}
	input := request.toDomain()
	input.ID = command.EntityID
	app, err := h.service.CreateInTx(ctx, tx, command.UserID, command.DeviceID, input)
	return applicationResult(app, err)
}

func (h *ApplicationCommandHandler) applyUpdate(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	var request applicationUpdateCommand
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_application"), nil
	}
	app, err := h.service.UpdateInTx(
		ctx, tx, command.UserID, command.DeviceID, command.EntityID,
		request.toDomain(*command.ExpectedVersion),
	)
	return applicationResult(app, err)
}

func (h *ApplicationCommandHandler) applyTransition(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	var request transitionCommand
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_application"), nil
	}
	app, err := h.service.TransitionInTx(
		ctx, tx, command.UserID, command.DeviceID, command.EntityID,
		request.toDomain(*command.ExpectedVersion, command.OperationID),
	)
	return applicationResult(app, err)
}

func (h *ApplicationCommandHandler) applyDelete(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	app, err := h.service.DeleteInTx(
		ctx, tx, command.UserID, command.DeviceID, command.EntityID, *command.ExpectedVersion,
	)
	return applicationResult(app, err)
}

func applicationResult(app domain.Application, err error) (syncmod.ApplyResult, error) {
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrIllegalTransition):
			return failure(syncmod.ResultValidationFailed, "illegal_transition"), nil
		case errors.Is(err, domain.ErrDuplicate):
			return failure(syncmod.ResultConflict, "duplicate_application"), nil
		case errors.Is(err, domain.ErrNotFound):
			return failure(syncmod.ResultValidationFailed, "application_not_found"), nil
		case errors.Is(err, domain.ErrInvalidInput):
			return failure(syncmod.ResultValidationFailed, "invalid_application"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	return applied(app.EntityVersion, applicationPayloadOf(app)), nil
}
