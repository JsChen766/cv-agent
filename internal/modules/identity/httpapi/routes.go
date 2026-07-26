package httpapi

import "github.com/go-chi/chi/v5"

// Routes registers identity endpoints under a /v1 router.
//
// devPasswordLogin controls whether the local/test password endpoint is
// mounted at all; production must never register it.
func (h *Handler) Routes(router chi.Router, devPasswordLogin bool) {
	router.Route("/auth", func(auth chi.Router) {
		if devPasswordLogin {
			auth.Post("/login", h.DevLogin)
		}
		auth.With(RequireSession(h.sessions)).Post("/logout", h.Logout)
	})
	router.Route("/users", func(users chi.Router) {
		users.With(RequireSession(h.sessions)).Get("/me", h.CurrentUser)
	})
}
