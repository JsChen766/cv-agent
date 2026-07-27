package httpapi

import (
	"errors"
	"net/http"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	platformhttp "coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/id"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	defaultPageLimit  = 100
	maxPageLimit      = 500
	maxBootstrapBody  = 8 * 1024
	maxPushBody       = 8 * 1024 * 1024
	maxPushOperations = 100
)

type Handler struct {
	push      *syncmod.PushService
	pull      *syncmod.PullService
	bootstrap *syncmod.BootstrapService
}

func NewHandler(
	push *syncmod.PushService,
	pull *syncmod.PullService,
	bootstrap *syncmod.BootstrapService,
) *Handler {
	return &Handler{push: push, pull: pull, bootstrap: bootstrap}
}

func (h *Handler) Routes(router chi.Router) {
	router.Post("/sync/push", h.Push)
	router.Get("/sync/pull", h.Pull)
	router.Post("/sync/bootstrap", h.Bootstrap)
}

func (h *Handler) Push(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "session_invalid", "会话无效或已过期")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 1 || len(key) > 160 {
		writeError(w, r, http.StatusBadRequest, "bad_request", "批次幂等键不合法")
		return
	}
	var request pushRequest
	if err := decodeJSON(r.Body, maxPushBody, &request); err != nil ||
		!validPushRequest(request) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "同步推送请求不合法")
		return
	}
	if request.DeviceID != principal.DeviceID {
		writeError(w, r, http.StatusForbidden, "device_mismatch", "设备与当前会话不匹配")
		return
	}
	result := h.push.Push(
		r.Context(), principal.UserID, principal.DeviceID,
		toOperations(request.Operations),
	)
	platformhttp.WriteSuccess(
		w, http.StatusOK, toPushResultDTO(result), middleware.GetReqID(r.Context()),
	)
}

func (h *Handler) Pull(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "session_invalid", "会话无效或已过期")
		return
	}
	limit, err := pageLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "bad_request", "同步分页参数不合法")
		return
	}
	page, err := h.pull.Pull(
		r.Context(), principal.UserID, r.URL.Query().Get("cursor"), limit,
	)
	if err != nil {
		writeSyncError(w, r, err)
		return
	}
	platformhttp.WriteSuccess(
		w, http.StatusOK, toPageDTO(page), middleware.GetReqID(r.Context()),
	)
}

func (h *Handler) Bootstrap(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "session_invalid", "会话无效或已过期")
		return
	}
	var request bootstrapRequest
	if err := decodeJSON(r.Body, maxBootstrapBody, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "bad_request", "同步初始化请求不合法")
		return
	}
	if !id.Valid(request.DeviceID) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "设备 ID 不合法")
		return
	}
	if request.DeviceID != principal.DeviceID {
		writeError(w, r, http.StatusForbidden, "device_mismatch", "设备与当前会话不匹配")
		return
	}
	limit := request.Limit
	if limit == 0 {
		limit = maxPageLimit
	}
	if limit < 1 || limit > maxPageLimit {
		writeError(w, r, http.StatusBadRequest, "bad_request", "同步分页参数不合法")
		return
	}
	cursor := ""
	if request.Cursor != nil {
		cursor = *request.Cursor
	}
	page, err := h.bootstrap.Bootstrap(r.Context(), principal.UserID, cursor, limit)
	if err != nil {
		writeSyncError(w, r, err)
		return
	}
	platformhttp.WriteSuccess(
		w, http.StatusOK, toPageDTO(page), middleware.GetReqID(r.Context()),
	)
}

func writeSyncError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, syncmod.ErrBootstrapNeeded):
		writeError(w, r, http.StatusConflict, "sync_bootstrap_required", "需要重新初始化本地同步数据")
	case errors.Is(err, syncmod.ErrCursorExpired):
		writeError(w, r, http.StatusConflict, "sync_cursor_expired", "同步游标已过期")
	case errors.Is(err, syncmod.ErrCursorInvalid):
		writeError(w, r, http.StatusBadRequest, "sync_cursor_invalid", "同步游标无效")
	default:
		writeError(w, r, http.StatusInternalServerError, "internal_error", "服务器内部错误")
	}
}

func writeError(
	w http.ResponseWriter,
	r *http.Request,
	status int,
	code string,
	message string,
) {
	platformhttp.WriteError(w, status, code, message, middleware.GetReqID(r.Context()))
}
