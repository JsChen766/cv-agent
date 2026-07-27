package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"
	"coolto.local/cv-agent-app-be/internal/platform/id"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const maxAuthBodyBytes = 8 * 1024

// Handler exposes identity HTTP endpoints backed by application services.
type Handler struct {
	devLogin     *application.DevLoginService
	sessions     *application.SessionIssuer
	secureCookie bool
}

// NewHandler wires the identity handler.
func NewHandler(
	devLogin *application.DevLoginService,
	sessions *application.SessionIssuer,
	secureCookie bool,
) *Handler {
	return &Handler{devLogin: devLogin, sessions: sessions, secureCookie: secureCookie}
}

// DevLogin handles POST /v1/auth/login for local/test environments.
func (h *Handler) DevLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Email == "" || req.Password == "" {
		writeBadRequest(w, r, "缺少邮箱或密码")
		return
	}
	issued, err := h.devLogin.Login(r.Context(), application.DevLoginInput{
		Email:    req.Email,
		Password: req.Password,
		Device:   req.Device.toInput(),
		Fallback: application.DeviceFallback{
			UserAgent: r.Header.Get("User-Agent"),
			RemoteIP:  clientIP(r),
		},
	})
	if err != nil {
		writeDomainError(w, r, err)
		return
	}
	h.setSessionCookie(w, issued)
	httpapi.WriteSuccess(w, http.StatusOK, loginUserDTO{
		UserID: issued.User.ID,
		Email:  issued.User.Email,
	}, middleware.GetReqID(r.Context()))
}

// RevokeDeviceSessions handles DELETE /v1/devices/{deviceId}/sessions.
func (h *Handler) RevokeDeviceSessions(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	if !ok {
		writeDomainError(w, r, domain.ErrSessionInvalid)
		return
	}
	deviceID := chi.URLParam(r, "deviceId")
	if !id.Valid(deviceID) {
		writeBadRequest(w, r, "设备 ID 格式错误")
		return
	}
	count, err := h.sessions.RevokeDevice(r.Context(), principal.UserID, deviceID)
	if err != nil {
		writeDomainError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, revokeSessionsResultDTO{
		DeviceID:            deviceID,
		RevokedSessionCount: count,
	}, middleware.GetReqID(r.Context()))
}

// CurrentUser handles GET /v1/users/me.
func (h *Handler) CurrentUser(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	if !ok {
		writeDomainError(w, r, domain.ErrSessionInvalid)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, currentUserDTO{
		ID:       principal.UserID,
		Email:    principal.Email,
		Status:   principal.Status,
		DeviceID: principal.DeviceID,
	}, middleware.GetReqID(r.Context()))
}

// Logout handles POST /v1/auth/logout.
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(accessTokenCookie)
	if err != nil || cookie.Value == "" {
		writeDomainError(w, r, domain.ErrSessionInvalid)
		return
	}
	if err := h.sessions.Logout(r.Context(), cookie.Value); err != nil {
		writeDomainError(w, r, err)
		return
	}
	h.clearSessionCookie(w)
	httpapi.WriteSuccess(w, http.StatusOK, logoutResultDTO{Message: "Logged out"},
		middleware.GetReqID(r.Context()))
}

func (h *Handler) setSessionCookie(w http.ResponseWriter, issued application.IssuedSession) {
	http.SetCookie(w, &http.Cookie{
		Name:     accessTokenCookie,
		Value:    issued.Token.String(),
		Path:     "/",
		Expires:  issued.ExpiresAt,
		HttpOnly: true,
		Secure:   h.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     accessTokenCookie,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxAuthBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			writeBadRequest(w, r, "请求体为空")
			return false
		}
		writeBadRequest(w, r, "请求体格式错误")
		return false
	}
	return true
}

func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
