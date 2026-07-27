package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/resume/application"
	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	maxBodyBytes = 1024 * 1024
	defaultLimit = 100
	maxLimit     = 500
)

// Handler exposes resume endpoints.
type Handler struct {
	service *application.Service
}

// NewHandler wires the handler.
func NewHandler(service *application.Service) *Handler {
	return &Handler{service: service}
}

// Routes mounts resume endpoints on an authenticated router.
func (h *Handler) Routes(router chi.Router) {
	router.Route("/product/resumes", func(r chi.Router) {
		r.Get("/", h.List)
		r.Post("/publish", h.PublishNew)
		r.Get("/{resumeId}", h.Get)
		r.Put("/{resumeId}/publish", h.PublishExisting)
		r.Patch("/{resumeId}", h.Patch)
		r.Delete("/{resumeId}", h.Delete)
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

// Get returns one full resume.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	resume, err := h.service.Get(r.Context(), principal.UserID, chi.URLParam(r, "resumeId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toFullDTO(resume), middleware.GetReqID(r.Context()))
}

// List returns a cursor page of resume summaries.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	key, hasKey, err := pagination.Decode(r.URL.Query().Get("cursor"))
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"游标不合法", middleware.GetReqID(r.Context()))
		return
	}
	filter := application.ListFilter{
		Limit: parseLimit(r.URL.Query().Get("limit")), Cursor: key, HasKey: hasKey,
	}
	if raw := r.URL.Query().Get("status"); raw != "" {
		status := domain.Status(raw)
		filter.Status = &status
	}
	items, err := h.service.List(r.Context(), principal.UserID, filter)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toListDTO(items, filter.Limit),
		middleware.GetReqID(r.Context()))
}

func toListDTO(items []domain.Resume, limit int) listDTO {
	summaries := make([]summaryDTO, 0, len(items))
	for _, resume := range items {
		summaries = append(summaries, toSummaryDTO(resume))
	}
	dto := listDTO{Items: summaries}
	if len(items) == limit && limit > 0 {
		last := items[len(items)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	return dto
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

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := middleware.GetReqID(r.Context())
	switch {
	case errors.Is(err, idempotency.ErrKeyRequired):
		httpapi.WriteError(w, http.StatusBadRequest, "idempotency_key_required", "idempotencyKey 不合法", requestID)
	case errors.Is(err, idempotency.ErrKeyReused):
		httpapi.WriteError(w, http.StatusConflict, "idempotency_key_reused", "idempotencyKey 已用于其他请求", requestID)
	case errors.Is(err, domain.ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "resume_not_found", "简历不存在", requestID)
	case errors.Is(err, domain.ErrVersionConflict):
		httpapi.WriteError(w, http.StatusConflict, "entity_version_conflict", "资源已在其他设备更新", requestID)
	case errors.Is(err, domain.ErrContentConflict):
		httpapi.WriteError(w, http.StatusConflict, "content_hash_conflict", "云端简历内容已变化", requestID)
	case errors.Is(err, domain.ErrDuplicate):
		httpapi.WriteError(w, http.StatusConflict, "resume_already_exists", "简历已存在", requestID)
	case errors.Is(err, domain.ErrInvalidInput):
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "invalid_resume", "简历字段不合法", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}
