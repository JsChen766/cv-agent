package httpapi

import (
	"errors"
	"net/http"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5/middleware"
)

// writeDomainError maps identity domain errors to stable HTTP responses.
func writeDomainError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := middleware.GetReqID(r.Context())
	switch {
	case errors.Is(err, domain.ErrInvalidCredentials):
		httpapi.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码错误", requestID)
	case errors.Is(err, domain.ErrSessionInvalid):
		httpapi.WriteError(w, http.StatusUnauthorized, "session_invalid", "会话无效或已过期", requestID)
	case errors.Is(err, domain.ErrUserNotActive):
		httpapi.WriteError(w, http.StatusForbidden, "user_not_active", "账号状态不允许登录", requestID)
	case errors.Is(err, domain.ErrDeviceRevoked):
		httpapi.WriteError(w, http.StatusForbidden, "device_revoked", "设备已被撤销", requestID)
	case errors.Is(err, domain.ErrDeviceConflict):
		httpapi.WriteError(w, http.StatusConflict, "device_conflict", "设备已归属其他账号", requestID)
	case errors.Is(err, domain.ErrInvalidDeviceInput):
		httpapi.WriteError(w, http.StatusBadRequest, "invalid_device", "设备信息无效", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}

func writeBadRequest(w http.ResponseWriter, r *http.Request, message string) {
	httpapi.WriteError(w, http.StatusBadRequest, "bad_request", message,
		middleware.GetReqID(r.Context()))
}
