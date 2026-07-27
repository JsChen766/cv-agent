package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/experience/application"
	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	maxBodyBytes = 64 * 1024
	defaultLimit = 100
	maxLimit     = 500
)

// Handler exposes experience endpoints.
type Handler struct {
	service *application.Service
}

// NewHandler wires the handler.
func NewHandler(service *application.Service) *Handler {
	return &Handler{service: service}
}

// Routes mounts experience endpoints on an authenticated router.
func (h *Handler) Routes(router chi.Router) {
	router.Route("/product/experiences", func(r chi.Router) {
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Get("/{experienceId}", h.Get)
		r.Put("/{experienceId}", h.Update)
		r.Delete("/{experienceId}", h.Delete)
		r.Get("/{experienceId}/revisions", h.ListRevisions)
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

// Get returns one experience with revisions.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	exp, err := h.service.Get(r.Context(), principal.UserID, chi.URLParam(r, "experienceId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toDetailDTO(exp), middleware.GetReqID(r.Context()))
}

// List returns a cursor page of experience summaries.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	filter, err := parseListFilter(r)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"列表参数不合法", middleware.GetReqID(r.Context()))
		return
	}
	items, err := h.service.List(r.Context(), principal.UserID, filter)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toListDTO(items, filter.Limit),
		middleware.GetReqID(r.Context()))
}

// ListRevisions returns immutable revisions newest first.
func (h *Handler) ListRevisions(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))
	after := 0
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		parsed, convErr := strconv.Atoi(raw)
		if convErr != nil || parsed < 1 {
			httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
				"游标不合法", middleware.GetReqID(r.Context()))
			return
		}
		after = parsed
	}
	revisions, err := h.service.ListRevisions(
		r.Context(), principal.UserID, chi.URLParam(r, "experienceId"), after, limit,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toRevisionListDTO(revisions, limit),
		middleware.GetReqID(r.Context()))
}

func parseListFilter(r *http.Request) (application.ListFilter, error) {
	query := r.URL.Query()
	filter := application.ListFilter{
		Query: query.Get("q"), Tags: query["tags"], Limit: parseLimit(query.Get("limit")),
	}
	if raw := query.Get("category"); raw != "" {
		category := domain.Category(raw)
		filter.Category = &category
	}
	key, hasKey, err := pagination.Decode(query.Get("cursor"))
	if err != nil {
		return application.ListFilter{}, err
	}
	filter.Cursor, filter.HasKey = key, hasKey
	return filter, nil
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

func toListDTO(items []domain.Experience, limit int) listDTO {
	summaries := make([]summaryDTO, 0, len(items))
	for _, exp := range items {
		summaries = append(summaries, toSummaryDTO(exp))
	}
	dto := listDTO{Items: summaries}
	if len(items) == limit && limit > 0 {
		last := items[len(items)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	return dto
}

func toRevisionListDTO(revisions []domain.Revision, limit int) revisionListDTO {
	items := make([]revisionDTO, 0, len(revisions))
	for _, rev := range revisions {
		items = append(items, toRevisionDTO(rev))
	}
	dto := revisionListDTO{Items: items}
	if len(revisions) == limit && limit > 0 {
		cursor := strconv.Itoa(revisions[len(revisions)-1].RevisionNumber)
		dto.NextCursor = &cursor
	}
	return dto
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := middleware.GetReqID(r.Context())
	switch {
	case errors.Is(err, idempotency.ErrKeyRequired):
		httpapi.WriteError(w, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key 不合法", requestID)
	case errors.Is(err, idempotency.ErrKeyReused):
		httpapi.WriteError(w, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key 已用于其他请求", requestID)
	case errors.Is(err, domain.ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "experience_not_found", "经历不存在", requestID)
	case errors.Is(err, domain.ErrVersionConflict):
		httpapi.WriteError(w, http.StatusConflict, "entity_version_conflict", "资源已在其他设备更新", requestID)
	case errors.Is(err, domain.ErrInvalidInput):
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "invalid_experience", "经历字段不合法", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}
