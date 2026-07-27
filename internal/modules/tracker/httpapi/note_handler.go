package httpapi

import (
	"net/http"

	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// ListNotes returns a cursor page of notes.
func (h *Handler) ListNotes(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	key, hasKey, err := pagination.Decode(r.URL.Query().Get("cursor"))
	if err != nil {
		badRequest(w, r)
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))
	notes, err := h.notes.List(
		r.Context(), principal.UserID, chi.URLParam(r, "applicationId"),
		childFilter(key, hasKey, limit),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dto := noteListDTO{Items: make([]noteDTO, 0, len(notes))}
	for _, note := range notes {
		dto.Items = append(dto.Items, toNoteDTO(note))
	}
	if len(notes) == limit && limit > 0 {
		last := notes[len(notes)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	httpapi.WriteSuccess(w, http.StatusOK, dto, middleware.GetReqID(r.Context()))
}

// GetNote returns one note.
func (h *Handler) GetNote(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	note, err := h.notes.Get(
		r.Context(), principal.UserID,
		chi.URLParam(r, "applicationId"), chi.URLParam(r, "noteId"),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toNoteDTO(note), middleware.GetReqID(r.Context()))
}

// CreateNote adds a note to an application.
func (h *Handler) CreateNote(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req noteRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	appID := chi.URLParam(r, "applicationId")
	command, err := createCommand(r, "note.create", struct {
		ApplicationID string
		Request       noteRequest
	}{appID, req})
	if err != nil {
		writeError(w, r, err)
		return
	}
	note, err := h.notes.Create(
		r.Context(), principal.UserID, principal.DeviceID,
		appID, req.toDomain(), command,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusCreated, toNoteDTO(note), middleware.GetReqID(r.Context()))
}

// ReplaceNote replaces a note under an optimistic lock.
func (h *Handler) ReplaceNote(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req noteRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	note, err := h.notes.Replace(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), chi.URLParam(r, "noteId"), req.toDomain(),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toNoteDTO(note), middleware.GetReqID(r.Context()))
}

// DeleteNote soft-deletes a note.
func (h *Handler) DeleteNote(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	expectedVersion, ok := parseExpectedVersion(w, r)
	if !ok {
		return
	}
	note, err := h.notes.Delete(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), chi.URLParam(r, "noteId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toNoteDTO(note), middleware.GetReqID(r.Context()))
}
