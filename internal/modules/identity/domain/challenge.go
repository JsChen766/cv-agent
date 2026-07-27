package domain

import "time"

// EmailChallenge is the persisted state of one passwordless login attempt.
type EmailChallenge struct {
	ID                    string
	EmailNormalized       string
	EmailDisplay          string
	CodeHash              []byte
	DeliveryStatus        string
	AttemptCount          int
	MaxAttempts           int
	ExpiresAt             time.Time
	ConsumedAt            *time.Time
	RequestIPHash         []byte
	DeviceFingerprintHash []byte
	CreatedAt             time.Time
}
