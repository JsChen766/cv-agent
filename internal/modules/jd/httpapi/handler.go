package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/jd/application"
	"coolto.local/cv-agent-app-be/internal/modules/jd/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/idempotency"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	maxBodyBytes = 256 * 1024
	defaultLimit = 100
	maxLimit     = 500
)

// Handler exposes JD endpoints.
type Handler struct {
	service *application.Service
}

// NewHandler wires the handler.
func NewHandler(service *application.Service) *Handler {
	return &Handler{service: service}
}

// Routes mounts JD endpoints on an authenticated router.
func (h *Handler) Routes(router chi.Router) {
	router.Route("/product/jds", func(r chi.Router) {
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Get("/{jdId}", h.Get)
		r.Put("/{jdId}", h.Replace)
		r.Delete("/{jdId}", h.Delete)
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

// Get returns one JD with requirements.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	jd, err := h.service.Get(r.Context(), principal.UserID, chi.URLParam(r, "jdId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toRecordDTO(jd), middleware.GetReqID(r.Context()))
}

// List returns a cursor page of JDs.
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
	limit := parseLimit(r.URL.Query().Get("limit"))
	items, err := h.service.List(r.Context(), principal.UserID, application.ListFilter{
		Limit: limit, Cursor: key, HasKey: hasKey,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toListDTO(items, limit), middleware.GetReqID(r.Context()))
}

// Create creates a JD asset.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req createRequest
	if err := decodeBody(r.Body, &req); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	requestHash, err := idempotency.Hash(req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	jd, err := h.service.Create(
		r.Context(), principal.UserID, principal.DeviceID, toWrite(req, 0), idempotency.Command{
			Scope: "jd.create", Key: r.Header.Get("Idempotency-Key"), RequestHash: requestHash,
		},
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusCreated, toRecordDTO(jd), middleware.GetReqID(r.Context()))
}

// Replace atomically replaces the JD and its complete requirements collection.
func (h *Handler) Replace(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req updateRequest
	if err := decodeBody(r.Body, &req); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	jd, err := h.service.Replace(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "jdId"), toWrite(req.createRequest, req.ExpectedVersion),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toRecordDTO(jd), middleware.GetReqID(r.Context()))
}

// Delete soft-deletes a JD and returns its tombstone record.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	expectedVersion, err := strconv.ParseInt(r.URL.Query().Get("expectedVersion"), 10, 64)
	if err != nil || expectedVersion < 1 {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"expectedVersion 不合法", middleware.GetReqID(r.Context()))
		return
	}
	jd, err := h.service.Delete(
		r.Context(), principal.UserID, principal.DeviceID, chi.URLParam(r, "jdId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toRecordDTO(jd), middleware.GetReqID(r.Context()))
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

func toListDTO(items []domain.JobDescription, limit int) listDTO {
	records := make([]recordDTO, 0, len(items))
	for _, jd := range items {
		records = append(records, toRecordDTO(jd))
	}
	dto := listDTO{Items: records}
	if len(items) == limit && limit > 0 {
		last := items[len(items)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	return dto
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
		httpapi.WriteError(w, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key 不合法", requestID)
	case errors.Is(err, idempotency.ErrKeyReused):
		httpapi.WriteError(w, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key 已用于其他请求", requestID)
	case errors.Is(err, domain.ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "jd_not_found", "JD 不存在", requestID)
	case errors.Is(err, domain.ErrVersionConflict):
		httpapi.WriteError(w, http.StatusConflict, "entity_version_conflict", "资源已在其他设备更新", requestID)
	case errors.Is(err, domain.ErrInvalidInput):
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "invalid_jd", "JD 字段不合法", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}
