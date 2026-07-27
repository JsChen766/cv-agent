package httpapi

import (
	"context"
	"net/http"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
)

// accessTokenCookie is the APP-compatible session cookie name.
const accessTokenCookie = "access_token"

// Authenticator resolves a session from a raw cookie token value.
type Authenticator interface {
	Authenticate(ctx context.Context, tokenValue string) (domain.User, domain.Session, error)
}

// RequireSession rejects requests without a valid access_token session and
// puts the shared Principal in the request context.
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
			principal := authctx.Principal{
				UserID:    user.ID,
				Email:     user.Email,
				Status:    string(user.Status),
				DeviceID:  session.DeviceID,
				SessionID: session.ID,
				ExpiresAt: session.ExpiresAt,
			}
			next.ServeHTTP(w, r.WithContext(authctx.With(r.Context(), principal)))
		})
	}
}

var _ Authenticator = (*application.SessionIssuer)(nil)
