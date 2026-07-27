package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/application"
	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	maxBodyBytes = 128 * 1024
	defaultLimit = 100
	maxLimit     = 500
	timeLayout   = "2006-01-02T15:04:05Z07:00"
)

// Handler exposes application tracker endpoints backed by the tracker services.
type Handler struct {
	apps       *application.ApplicationService
	interviews *application.InterviewService
	notes      *application.NoteService
	reminders  *application.ReminderService
}

// NewHandler wires the tracker HTTP handler.
func NewHandler(
	apps *application.ApplicationService,
	interviews *application.InterviewService,
	notes *application.NoteService,
	reminders *application.ReminderService,
) *Handler {
	return &Handler{apps: apps, interviews: interviews, notes: notes, reminders: reminders}
}

// Routes mounts tracker endpoints on an authenticated router.
func (h *Handler) Routes(router chi.Router) {
	router.Route("/product/applications", func(r chi.Router) {
		r.Get("/", h.ListApplications)
		r.Post("/", h.CreateApplication)
		r.Get("/{applicationId}", h.GetApplication)
		r.Put("/{applicationId}", h.UpdateApplication)
		r.Delete("/{applicationId}", h.DeleteApplication)
		r.Post("/{applicationId}/transitions", h.Transition)
		r.Get("/{applicationId}/status-events", h.ListStatusEvents)
		r.Get("/{applicationId}/interviews", h.ListInterviews)
		r.Post("/{applicationId}/interviews", h.CreateInterview)
		r.Get("/{applicationId}/interviews/{interviewId}", h.GetInterview)
		r.Put("/{applicationId}/interviews/{interviewId}", h.ReplaceInterview)
		r.Delete("/{applicationId}/interviews/{interviewId}", h.DeleteInterview)
		r.Get("/{applicationId}/notes", h.ListNotes)
		r.Post("/{applicationId}/notes", h.CreateNote)
		r.Get("/{applicationId}/notes/{noteId}", h.GetNote)
		r.Put("/{applicationId}/notes/{noteId}", h.ReplaceNote)
		r.Delete("/{applicationId}/notes/{noteId}", h.DeleteNote)
	})
	router.Route("/product/reminders", func(r chi.Router) {
		r.Get("/", h.ListReminders)
		r.Post("/", h.CreateReminder)
		r.Get("/{reminderId}", h.GetReminder)
		r.Put("/{reminderId}", h.ReplaceReminder)
		r.Delete("/{reminderId}", h.DeleteReminder)
	})
}

func principalOr401(w http.ResponseWriter, r *http.Request) (authctx.Principal, bool) {
	principal, ok := authctx.From(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "session_invalid",
			"会话无效或已过期", middleware.GetReqID(r.Context()))
	}
	return principal, ok
}

func decodeBody(body io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}

func parseLimit(raw string) int {
	if raw == "" {
		return defaultLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}

func childFilter(key pagination.Key, hasKey bool, limit int) application.ChildFilter {
	return application.ChildFilter{Limit: limit, Cursor: key, HasKey: hasKey}
}

func parseExpectedVersion(w http.ResponseWriter, r *http.Request) (int64, bool) {
	value, err := strconv.ParseInt(r.URL.Query().Get("expectedVersion"), 10, 64)
	if err != nil || value < 1 {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"expectedVersion 不合法", middleware.GetReqID(r.Context()))
		return 0, false
	}
	return value, true
}

func badRequest(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
		"请求体格式错误", middleware.GetReqID(r.Context()))
}

func createCommand(r *http.Request, scope string, value any) (idempotency.Command, error) {
	requestHash, err := idempotency.Hash(value)
	if err != nil {
		return idempotency.Command{}, err
	}
	return idempotency.Command{
		Scope: scope, Key: r.Header.Get("Idempotency-Key"), RequestHash: requestHash,
	}, nil
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := middleware.GetReqID(r.Context())
	switch {
	case errors.Is(err, idempotency.ErrKeyRequired):
		httpapi.WriteError(w, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key 不合法", requestID)
	case errors.Is(err, idempotency.ErrKeyReused):
		httpapi.WriteError(w, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key 已用于其他请求", requestID)
	case errors.Is(err, domain.ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "application_not_found", "投递记录不存在", requestID)
	case errors.Is(err, domain.ErrVersionConflict):
		httpapi.WriteError(w, http.StatusConflict, "entity_version_conflict", "资源已在其他设备更新", requestID)
	case errors.Is(err, domain.ErrIllegalTransition):
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "illegal_transition", "非法的状态流转", requestID)
	case errors.Is(err, domain.ErrRoundConflict):
		httpapi.WriteError(w, http.StatusConflict, "interview_round_conflict", "面试轮次编号冲突", requestID)
	case errors.Is(err, domain.ErrOperationReused):
		httpapi.WriteError(w, http.StatusConflict, "operation_id_reused", "operationId 已用于其他状态变更", requestID)
	case errors.Is(err, domain.ErrDuplicate):
		httpapi.WriteError(w, http.StatusConflict, "duplicate_application", "投递记录已存在", requestID)
	case errors.Is(err, domain.ErrInvalidInput):
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "invalid_application", "字段不合法", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}
