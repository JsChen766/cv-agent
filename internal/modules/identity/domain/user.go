package domain

import "errors"

// Sentinel errors mapped to stable HTTP error codes at the boundary.
var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrSessionInvalid     = errors.New("session invalid")
	ErrUserNotActive      = errors.New("user not active")
	ErrDeviceRevoked      = errors.New("device revoked")
	ErrDeviceNotFound     = errors.New("device not found")
	ErrDeviceConflict     = errors.New("device conflict")
	ErrInvalidDeviceInput = errors.New("invalid device input")
	ErrChallengeInvalid   = errors.New("email challenge invalid")
	ErrChallengeExpired   = errors.New("email challenge expired")
	ErrChallengeAttempts  = errors.New("email challenge attempts exhausted")
	ErrRateLimited        = errors.New("authentication rate limited")
	ErrEmailDelivery      = errors.New("email delivery failed")
)

// UserStatus enumerates account lifecycle states.
type UserStatus string

const (
	UserStatusActive          UserStatus = "active"
	UserStatusSuspended       UserStatus = "suspended"
	UserStatusPendingDeletion UserStatus = "pending_deletion"
	UserStatusDeleted         UserStatus = "deleted"
)

// CanAuthenticate reports whether a user in this status may hold live sessions.
func (s UserStatus) CanAuthenticate() bool {
	return s == UserStatusActive
}

// User is the identity aggregate root minimal projection for auth flows.
type User struct {
	ID     string
	Status UserStatus
	Email  string
}
