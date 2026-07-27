package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Routes registers identity endpoints under a /v1 router.
//
// devPasswordLogin controls whether the local/test password endpoint is
// mounted at all; production must never register it. secured is applied to
// endpoints that require an authenticated session.
func (h *Handler) Routes(router chi.Router, devPasswordLogin bool, secured func(http.Handler) http.Handler) {
	router.Route("/auth", func(auth chi.Router) {
		if devPasswordLogin {
			auth.Post("/login", h.DevLogin)
		}
		auth.With(secured).Post("/logout", h.Logout)
	})
	router.Route("/users", func(users chi.Router) {
		users.With(secured).Get("/me", h.CurrentUser)
	})
	router.Route("/devices", func(devices chi.Router) {
		devices.With(secured).Delete("/{deviceId}/sessions", h.RevokeDeviceSessions)
	})
}
