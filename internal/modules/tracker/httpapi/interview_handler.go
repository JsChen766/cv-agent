package httpapi

import (
	"net/http"

	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// ListInterviews returns a cursor page of interview rounds.
func (h *Handler) ListInterviews(w http.ResponseWriter, r *http.Request) {
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
	rounds, err := h.interviews.List(
		r.Context(), principal.UserID, chi.URLParam(r, "applicationId"),
		childFilter(key, hasKey, limit),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dto := interviewListDTO{Items: make([]interviewDTO, 0, len(rounds))}
	for _, round := range rounds {
		dto.Items = append(dto.Items, toInterviewDTO(round))
	}
	if len(rounds) == limit && limit > 0 {
		last := rounds[len(rounds)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	httpapi.WriteSuccess(w, http.StatusOK, dto, middleware.GetReqID(r.Context()))
}

// GetInterview returns one interview round.
func (h *Handler) GetInterview(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	round, err := h.interviews.Get(
		r.Context(), principal.UserID,
		chi.URLParam(r, "applicationId"), chi.URLParam(r, "interviewId"),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toInterviewDTO(round), middleware.GetReqID(r.Context()))
}

// CreateInterview adds an interview round to an application.
func (h *Handler) CreateInterview(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req interviewRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	appID := chi.URLParam(r, "applicationId")
	command, err := createCommand(r, "interview.create", struct {
		ApplicationID string
		Request       interviewRequest
	}{appID, req})
	if err != nil {
		writeError(w, r, err)
		return
	}
	round, err := h.interviews.Create(
		r.Context(), principal.UserID, principal.DeviceID,
		appID, req.toDomain(), command,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusCreated, toInterviewDTO(round), middleware.GetReqID(r.Context()))
}

// ReplaceInterview replaces an interview round under an optimistic lock.
func (h *Handler) ReplaceInterview(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req interviewRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	round, err := h.interviews.Replace(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), chi.URLParam(r, "interviewId"), req.toDomain(),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toInterviewDTO(round), middleware.GetReqID(r.Context()))
}

// DeleteInterview soft-deletes an interview round.
func (h *Handler) DeleteInterview(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	expectedVersion, ok := parseExpectedVersion(w, r)
	if !ok {
		return
	}
	round, err := h.interviews.Delete(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), chi.URLParam(r, "interviewId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toInterviewDTO(round), middleware.GetReqID(r.Context()))
}
