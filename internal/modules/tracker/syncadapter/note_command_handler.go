package syncadapter

import (
	"context"
	"errors"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

	"github.com/jackc/pgx/v5"
)

type noteCommand struct {
	ApplicationID    string  `json:"applicationId"`
	InterviewRoundID *string `json:"interviewRoundId"`
	NoteType         string  `json:"noteType"`
	Content          string  `json:"content"`
}

func (c noteCommand) toDomain(expectedVersion *int64) domain.NoteWrite {
	return domain.NoteWrite{
		ExpectedVersion: expectedVersion, InterviewRoundID: c.InterviewRoundID,
		NoteType: domain.NoteType(c.NoteType), Content: c.Content,
	}
}

// NoteCommandHandler applies note push commands.
type NoteCommandHandler struct {
	service *application.NoteService
}

// NewNoteCommandHandler wires the handler.
func NewNoteCommandHandler(service *application.NoteService) *NoteCommandHandler {
	return &NoteCommandHandler{service: service}
}

// EntityType identifies notes on the command feed.
func (h *NoteCommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeApplicationNote
}

// Apply routes a push command to the matching note use case.
func (h *NoteCommandHandler) Apply(
	ctx context.Context, tx pgx.Tx, command syncmod.Command,
) (syncmod.ApplyResult, error) {
	switch command.Action {
	case syncmod.ActionCreate:
		var request noteCommand
		if err := decodePayload(command.Payload, &request); err != nil {
			return failure(syncmod.ResultValidationFailed, "invalid_note"), nil
		}
		write := request.toDomain(nil)
		write.ID = command.EntityID
		note, err := h.service.CreateInTx(
			ctx, tx, command.UserID, command.DeviceID, request.ApplicationID, write,
		)
		return noteResult(note, err)
	case syncmod.ActionUpdate:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		var request noteCommand
		if err := decodePayload(command.Payload, &request); err != nil {
			return failure(syncmod.ResultValidationFailed, "invalid_note"), nil
		}
		note, err := h.service.ReplaceInTx(
			ctx, tx, command.UserID, command.DeviceID, command.EntityID,
			request.toDomain(command.ExpectedVersion),
		)
		return noteResult(note, err)
	case syncmod.ActionDelete:
		if command.ExpectedVersion == nil {
			return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
		}
		note, err := h.service.DeleteInTx(
			ctx, tx, command.UserID, command.DeviceID, command.EntityID, *command.ExpectedVersion,
		)
		return noteResult(note, err)
	default:
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
}

func noteResult(note domain.Note, err error) (syncmod.ApplyResult, error) {
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrNotFound):
			return failure(syncmod.ResultValidationFailed, "note_not_found"), nil
		case errors.Is(err, domain.ErrInvalidInput):
			return failure(syncmod.ResultValidationFailed, "invalid_note"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	return applied(note.EntityVersion, notePayloadOf(note)), nil
}
