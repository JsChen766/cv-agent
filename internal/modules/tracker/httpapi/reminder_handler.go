package httpapi

import (
	"net/http"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/id"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// ListReminders returns a cursor page of reminders.
func (h *Handler) ListReminders(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	filter, err := parseReminderFilter(r)
	if err != nil {
		badRequest(w, r)
		return
	}
	reminders, err := h.reminders.List(r.Context(), principal.UserID, filter)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dto := reminderListDTO{Items: make([]reminderDTO, 0, len(reminders))}
	for _, reminder := range reminders {
		dto.Items = append(dto.Items, toReminderDTO(reminder))
	}
	if len(reminders) == filter.Limit && filter.Limit > 0 {
		last := reminders[len(reminders)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	httpapi.WriteSuccess(w, http.StatusOK, dto, middleware.GetReqID(r.Context()))
}

func parseReminderFilter(r *http.Request) (application.ReminderFilter, error) {
	query := r.URL.Query()
	filter := application.ReminderFilter{Limit: parseLimit(query.Get("limit"))}
	if raw := query.Get("applicationId"); raw != "" {
		if !id.Valid(raw) {
			return application.ReminderFilter{}, domain.ErrInvalidInput
		}
		filter.ApplicationID = &raw
	}
	if raw := query.Get("status"); raw != "" {
		status := domain.ReminderStatus(raw)
		if !validReminderStatus(status) {
			return application.ReminderFilter{}, domain.ErrInvalidInput
		}
		filter.Status = &status
	}
	key, hasKey, err := pagination.Decode(query.Get("cursor"))
	if err != nil {
		return application.ReminderFilter{}, err
	}
	filter.Cursor, filter.HasKey = key, hasKey
	return filter, nil
}

func validReminderStatus(status domain.ReminderStatus) bool {
	switch status {
	case domain.ReminderScheduled, domain.ReminderDelivered,
		domain.ReminderDismissed, domain.ReminderCanceled:
		return true
	default:
		return false
	}
}

// GetReminder returns one reminder.
func (h *Handler) GetReminder(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	reminder, err := h.reminders.Get(r.Context(), principal.UserID, chi.URLParam(r, "reminderId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toReminderDTO(reminder), middleware.GetReqID(r.Context()))
}

// CreateReminder records a new reminder.
func (h *Handler) CreateReminder(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req reminderRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	command, err := createCommand(r, "reminder.create", req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	reminder, err := h.reminders.Create(
		r.Context(), principal.UserID, principal.DeviceID, req.toDomain(), command,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusCreated, toReminderDTO(reminder), middleware.GetReqID(r.Context()))
}

// ReplaceReminder replaces a reminder under an optimistic lock.
func (h *Handler) ReplaceReminder(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req reminderRequest
	if err := decodeBody(r.Body, &req); err != nil {
		badRequest(w, r)
		return
	}
	reminder, err := h.reminders.Replace(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "reminderId"), req.toDomain(),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toReminderDTO(reminder), middleware.GetReqID(r.Context()))
}

// DeleteReminder soft-deletes a reminder.
func (h *Handler) DeleteReminder(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	expectedVersion, ok := parseExpectedVersion(w, r)
	if !ok {
		return
	}
	reminder, err := h.reminders.Delete(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "reminderId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toReminderDTO(reminder), middleware.GetReqID(r.Context()))
}
