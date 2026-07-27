package httpapi

import (
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// ListApplications returns a cursor page of the tracker board.
func (h *Handler) ListApplications(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	filter, err := parseApplicationFilter(r)
	if err != nil {
		badRequest(w, r)
		return
	}
	items, err := h.apps.List(r.Context(), principal.UserID, filter)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dto := applicationListDTO{Items: make([]applicationDTO, 0, len(items))}
	for _, app := range items {
		dto.Items = append(dto.Items, toApplicationDTO(app))
	}
	if len(items) == filter.Limit && filter.Limit > 0 {
		last := items[len(items)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	httpapi.WriteSuccess(w, http.StatusOK, dto, middleware.GetReqID(r.Context()))
}

func parseApplicationFilter(r *http.Request) (application.ApplicationFilter, error) {
	query := r.URL.Query()
	filter := application.ApplicationFilter{
		Company: query.Get("company"), Limit: parseLimit(query.Get("limit")),
	}
	if raw := query.Get("status"); raw != "" {
		status := domain.Status(raw)
		if !validApplicationStatus(status) {
			return application.ApplicationFilter{}, domain.ErrInvalidInput
		}
		filter.Status = &status
	}
	if raw := query.Get("jdId"); raw != "" {
		if !id.Valid(raw) {
			return application.ApplicationFilter{}, domain.ErrInvalidInput
		}
		filter.JdID = &raw
	}
	if raw := query.Get("resumeId"); raw != "" {
		if !id.Valid(raw) {
			return application.ApplicationFilter{}, domain.ErrInvalidInput
		}
		filter.ResumeID = &raw
	}
	if raw := query.Get("pendingConfirmation"); raw != "" {
		pending, err := strconv.ParseBool(raw)
		if err != nil {
			return application.ApplicationFilter{}, domain.ErrInvalidInput
		}
		filter.PendingConfirmation = &pending
	}
	key, hasKey, err := pagination.Decode(query.Get("cursor"))
	if err != nil {
		return application.ApplicationFilter{}, err
	}
	filter.Cursor, filter.HasKey = key, hasKey
	return filter, nil
}

func validApplicationStatus(status domain.Status) bool {
	switch status {
	case domain.StatusApplied, domain.StatusScreening, domain.StatusInterviewing,
		domain.StatusOffer, domain.StatusRejected, domain.StatusNoResponse:
		return true
	default:
		return false
	}
}

// GetApplication returns one application.
func (h *Handler) GetApplication(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	app, err := h.apps.Get(r.Context(), principal.UserID, chi.URLParam(r, "applicationId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toApplicationDTO(app), middleware.GetReqID(r.Context()))
}

// CreateApplication records a new application.
func (h *Handler) CreateApplication(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req applicationCreateRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	command, err := createCommand(r, "application.create", req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	app, err := h.apps.Create(
		r.Context(), principal.UserID, principal.DeviceID, req.toDomain(), command,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusCreated, toApplicationDTO(app), middleware.GetReqID(r.Context()))
}

// UpdateApplication updates tracker metadata without changing status.
func (h *Handler) UpdateApplication(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req applicationUpdateRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	app, err := h.apps.Update(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), req.toDomain(),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toApplicationDTO(app), middleware.GetReqID(r.Context()))
}

// DeleteApplication soft-deletes an application.
func (h *Handler) DeleteApplication(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	expectedVersion, ok := parseExpectedVersion(w, r)
	if !ok {
		return
	}
	app, err := h.apps.Delete(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "applicationId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toApplicationDTO(app), middleware.GetReqID(r.Context()))
}
