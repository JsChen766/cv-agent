package authctx

import (
	"context"
	"time"
)

// Principal is the shared read-only view of the authenticated caller.
type Principal struct {
	UserID    string
	Email     string
	Status    string
	DeviceID  string
	SessionID string
	ExpiresAt time.Time
}

type ctxKey struct{}

// With returns a context carrying the authenticated principal.
func With(parent context.Context, principal Principal) context.Context {
	return context.WithValue(parent, ctxKey{}, principal)
}

// From returns the principal if present.
func From(ctx context.Context) (Principal, bool) {
	value, ok := ctx.Value(ctxKey{}).(Principal)
	return value, ok
}
