package syncadapter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
)

// CommandHandler applies JD push commands.
type CommandHandler struct {
	service *application.Service
}

// NewCommandHandler wires the handler.
func NewCommandHandler(service *application.Service) *CommandHandler {
	return &CommandHandler{service: service}
}

// EntityType identifies JDs on the command feed.
func (h *CommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeJobDescription
}

// Apply routes a push command to the matching use case inside Push's tx.
func (h *CommandHandler) Apply(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	switch command.Action {
	case syncmod.ActionCreate:
		return h.applyCreate(ctx, tx, command)
	case syncmod.ActionUpdate:
		return h.applyUpdate(ctx, tx, command)
	case syncmod.ActionDelete:
		return h.applyDelete(ctx, tx, command)
	default:
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
}

func (h *CommandHandler) applyCreate(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	var request writePayload
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_jd"), nil
	}
	write := request.toDomain(0)
	write.ID = command.EntityID
	jd, err := h.service.CreateInTx(ctx, tx, command.UserID, command.DeviceID, write)
	return result(jd, err)
}

func (h *CommandHandler) applyUpdate(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	var request writePayload
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_jd"), nil
	}
	jd, err := h.service.ReplaceInTx(
		ctx, tx, command.UserID, command.DeviceID, command.EntityID,
		request.toDomain(*command.ExpectedVersion),
	)
	return result(jd, err)
}

func (h *CommandHandler) applyDelete(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	jd, err := h.service.DeleteInTx(
		ctx, tx, command.UserID, command.DeviceID, command.EntityID, *command.ExpectedVersion,
	)
	return result(jd, err)
}

func result(jd domain.JobDescription, err error) (syncmod.ApplyResult, error) {
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrNotFound):
			return failure(syncmod.ResultValidationFailed, "jd_not_found"), nil
		case errors.Is(err, domain.ErrInvalidInput):
			return failure(syncmod.ResultValidationFailed, "invalid_jd"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	version := jd.EntityVersion
	return syncmod.ApplyResult{
		Status: syncmod.ResultApplied, AppliedVersion: &version,
		ServerEntity: toProjection(jd).Payload,
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
