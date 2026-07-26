package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

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
	if req.Email == "" || req.Password == "" || !req.Device.valid() {
		writeBadRequest(w, r, "缺少邮箱、密码或设备信息")
		return
	}
	issued, err := h.devLogin.Login(r.Context(), application.DevLoginInput{
		Email:    req.Email,
		Password: req.Password,
		Device:   req.Device.toInput(),
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

// CurrentUser handles GET /v1/users/me.
func (h *Handler) CurrentUser(w http.ResponseWriter, r *http.Request) {
	auth, ok := AuthFromContext(r.Context())
	if !ok {
		writeDomainError(w, r, domain.ErrSessionInvalid)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, currentUserDTO{
		ID:     auth.User.ID,
		Email:  auth.User.Email,
		Status: string(auth.User.Status),
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
