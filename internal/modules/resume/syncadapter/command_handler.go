package syncadapter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"coolto.local/cv-agent-app-be/internal/modules/resume/application"
	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
)

// CommandHandler applies resume push commands.
type CommandHandler struct {
	service *application.Service
}

// NewCommandHandler wires the handler.
func NewCommandHandler(service *application.Service) *CommandHandler {
	return &CommandHandler{service: service}
}

// EntityType identifies resumes on the command feed.
func (h *CommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeResume
}

// Apply routes a push command to the matching use case inside Push's tx.
func (h *CommandHandler) Apply(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	switch command.Action {
	case syncmod.ActionCreate:
		return h.applyPublish(ctx, tx, command, nil)
	case syncmod.ActionUpdate:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		return h.applyPublish(ctx, tx, command, command.ExpectedVersion)
	case syncmod.ActionDelete:
		return h.applyDelete(ctx, tx, command)
	default:
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
}

func (h *CommandHandler) applyPublish(
	ctx context.Context, tx pgx.Tx, command syncmod.Command, expectedVersion *int64,
) (syncmod.ApplyResult, error) {
	var request publishPayload
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_resume"), nil
	}
	input := request.toDomain(expectedVersion)
	input.ID = command.EntityID
	resume, _, err := h.service.PublishInTx(ctx, tx, command.UserID, command.DeviceID, input)
	return result(resume, err)
}

func (h *CommandHandler) applyDelete(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	resume, err := h.service.DeleteInTx(
		ctx, tx, command.UserID, command.DeviceID, command.EntityID, *command.ExpectedVersion,
	)
	return result(resume, err)
}

func result(resume domain.Resume, err error) (syncmod.ApplyResult, error) {
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict), errors.Is(err, domain.ErrContentConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrNotFound):
			return failure(syncmod.ResultValidationFailed, "resume_not_found"), nil
		case errors.Is(err, domain.ErrInvalidInput):
			return failure(syncmod.ResultValidationFailed, "invalid_resume"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	version := resume.EntityVersion
	return syncmod.ApplyResult{
		Status: syncmod.ResultApplied, AppliedVersion: &version,
		ServerEntity: toProjection(resume).Payload,
	}, nil
}

func decodePayload(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("payload contains trailing JSON")
	}
	return nil
}

func failure(status syncmod.ResultStatus, code string) syncmod.ApplyResult {
	return syncmod.ApplyResult{Status: status, ErrorCode: code}
}
