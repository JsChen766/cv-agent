package httpapi

import (
	"context"
	"net/http"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
)

// accessTokenCookie is the APP-compatible session cookie name.
const accessTokenCookie = "access_token"

type contextKey string

const authContextKey contextKey = "identity.auth"

// AuthContext carries the authenticated principal for downstream handlers.
type AuthContext struct {
	User    domain.User
	Session domain.Session
}

// Authenticator resolves a session from a raw cookie token value.
type Authenticator interface {
	Authenticate(ctx context.Context, tokenValue string) (domain.User, domain.Session, error)
}

// RequireSession rejects requests without a valid access_token session.
func RequireSession(auth Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(accessTokenCookie)
			if err != nil || cookie.Value == "" {
				writeDomainError(w, r, domain.ErrSessionInvalid)
				return
			}
			user, session, err := auth.Authenticate(r.Context(), cookie.Value)
			if err != nil {
				writeDomainError(w, r, err)
				return
			}
			ctx := context.WithValue(r.Context(), authContextKey, AuthContext{User: user, Session: session})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// AuthFromContext returns the authenticated principal if present.
func AuthFromContext(ctx context.Context) (AuthContext, bool) {
	value, ok := ctx.Value(authContextKey).(AuthContext)
	return value, ok
}

var _ Authenticator = (*application.SessionIssuer)(nil)
