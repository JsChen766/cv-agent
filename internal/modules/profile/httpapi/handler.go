package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"coolto.local/cv-agent-app-be/internal/modules/profile/application"
	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const maxProfileBodyBytes = 32 * 1024

// Handler exposes profile endpoints.
type Handler struct {
	service *application.Service
}

// NewHandler wires the handler.
func NewHandler(service *application.Service) *Handler {
	return &Handler{service: service}
}

// Routes mounts profile endpoints on an authenticated router.
func (h *Handler) Routes(router chi.Router) {
	router.Get("/users/me/profile", h.Get)
	router.Put("/users/me/profile", h.Put)
}

// Get returns the current user's profile.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	requestID := middleware.GetReqID(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "session_invalid", "会话无效或已过期", requestID)
		return
	}
	profile, err := h.service.Get(r.Context(), principal.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toDTO(profile, principal.Email), requestID)
}

// Put replaces the current user's profile with optimistic locking.
func (h *Handler) Put(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	requestID := middleware.GetReqID(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "session_invalid", "会话无效或已过期", requestID)
		return
	}
	var req updateRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxProfileBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		message := "请求体格式错误"
		if errors.Is(err, io.EOF) {
			message = "请求体为空"
		}
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request", message, requestID)
		return
	}
	profile, err := h.service.Replace(
		r.Context(), principal.UserID, principal.DeviceID, fromRequest(req),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toDTO(profile, principal.Email), requestID)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := middleware.GetReqID(r.Context())
	switch {
	case errors.Is(err, domain.ErrProfileNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "profile_not_found", "档案不存在", requestID)
	case errors.Is(err, domain.ErrVersionConflict):
		httpapi.WriteError(w, http.StatusConflict, "entity_version_conflict", "资源已在其他设备更新", requestID)
	case errors.Is(err, domain.ErrInvalidInput):
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "invalid_profile", "档案字段不合法", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}
