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
	case errors.Is(err, domain.ErrDeviceNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "device_not_found", "设备不存在", requestID)
	case errors.Is(err, domain.ErrDeviceConflict):
		httpapi.WriteError(w, http.StatusConflict, "device_conflict", "设备已归属其他账号", requestID)
	case errors.Is(err, domain.ErrInvalidDeviceInput):
		httpapi.WriteError(w, http.StatusBadRequest, "invalid_device", "设备信息无效", requestID)
	case errors.Is(err, domain.ErrChallengeInvalid):
		httpapi.WriteError(w, http.StatusUnauthorized, "invalid_email_code", "验证码无效", requestID)
	case errors.Is(err, domain.ErrChallengeExpired):
		httpapi.WriteError(w, http.StatusUnauthorized, "email_code_expired", "验证码已过期", requestID)
	case errors.Is(err, domain.ErrChallengeAttempts):
		httpapi.WriteError(w, http.StatusTooManyRequests, "email_code_attempts_exhausted", "验证码尝试次数已用完", requestID)
	case errors.Is(err, domain.ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		httpapi.WriteError(w, http.StatusTooManyRequests, "auth_rate_limited", "请求过于频繁，请稍后再试", requestID)
	case errors.Is(err, domain.ErrEmailDelivery):
		httpapi.WriteError(w, http.StatusServiceUnavailable, "email_delivery_failed", "验证码发送失败，请稍后再试", requestID)
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
	}
}

func writeBadRequest(w http.ResponseWriter, r *http.Request, message string) {
	httpapi.WriteError(w, http.StatusBadRequest, "bad_request", message,
		middleware.GetReqID(r.Context()))
}
