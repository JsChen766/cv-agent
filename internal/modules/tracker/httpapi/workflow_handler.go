package httpapi

import (
	"net/http"

	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Transition applies a validated status transition.
func (h *Handler) Transition(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req transitionRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	app, err := h.apps.Transition(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), req.toDomain(),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toApplicationDTO(app), middleware.GetReqID(r.Context()))
}

// ListStatusEvents returns immutable status events for one application.
func (h *Handler) ListStatusEvents(w http.ResponseWriter, r *http.Request) {
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
	events, err := h.apps.ListStatusEvents(
		r.Context(), principal.UserID, chi.URLParam(r, "applicationId"),
		childFilter(key, hasKey, limit),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dto := statusEventListDTO{Items: make([]statusEventDTO, 0, len(events))}
	for _, event := range events {
		dto.Items = append(dto.Items, toStatusEventDTO(event))
	}
	if len(events) == limit && limit > 0 {
		last := events[len(events)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.OccurredAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	httpapi.WriteSuccess(w, http.StatusOK, dto, middleware.GetReqID(r.Context()))
}
