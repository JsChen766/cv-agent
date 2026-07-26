package domain

import "time"

// Session is an opaque access_token session bound to a user and device.
type Session struct {
	ID         string
	UserID     string
	DeviceID   string
	TokenHash  []byte
	ExpiresAt  time.Time
	LastUsedAt time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
}

// IsLive reports whether the session may still authenticate a request at now.
func (s Session) IsLive(now time.Time) bool {
	if s.RevokedAt != nil {
		return false
	}
	return now.Before(s.ExpiresAt)
}

// Device is an APP installation instance owned by a user.
type Device struct {
	ID         string
	UserID     string
	Name       string
	Platform   string
	AppVersion string
	LastSeenAt time.Time
	RevokedAt  *time.Time
}

// IsActive reports whether the device may hold sessions.
func (d Device) IsActive() bool {
	return d.RevokedAt == nil
}

// ValidPlatform reports whether a platform value is accepted.
func ValidPlatform(platform string) bool {
	switch platform {
	case "macos", "windows", "linux":
		return true
	default:
		return false
	}
}
