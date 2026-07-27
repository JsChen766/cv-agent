package httpapi

import "coolto.local/cv-agent-app-be/internal/modules/identity/application"

type deviceDTO struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	AppVersion string `json:"appVersion"`
}

func (d *deviceDTO) toInput() *application.DeviceInput {
	if d == nil {
		return nil
	}
	return &application.DeviceInput{
		ID:         d.ID,
		Name:       d.Name,
		Platform:   d.Platform,
		AppVersion: d.AppVersion,
	}
}

type loginRequest struct {
	Email    string     `json:"email"`
	Password string     `json:"password"`
	Device   *deviceDTO `json:"device,omitempty"`
}

type loginUserDTO struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
}

type currentUserDTO struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Status   string `json:"status"`
	DeviceID string `json:"deviceId"`
}

type logoutResultDTO struct {
	Message string `json:"message"`
}

type revokeSessionsResultDTO struct {
	DeviceID            string `json:"deviceId"`
	RevokedSessionCount int64  `json:"revokedSessionCount"`
}

type emailChallengeRequest struct {
	ChallengeID string    `json:"challengeId"`
	Email       string    `json:"email"`
	Purpose     string    `json:"purpose"`
	Device      deviceDTO `json:"device"`
}

type emailChallengeAcceptedDTO struct {
	ChallengeID       string `json:"challengeId"`
	ExpiresAt         string `json:"expiresAt"`
	RetryAfterSeconds int    `json:"retryAfterSeconds"`
}

type emailVerifyRequest struct {
	ChallengeID string    `json:"challengeId"`
	Code        string    `json:"code"`
	Device      deviceDTO `json:"device"`
}

type emailLoginResultDTO struct {
	User         currentUserDTO `json:"user"`
	Device       loginDeviceDTO `json:"device"`
	Entitlements entitlementDTO `json:"entitlements"`
}

type loginDeviceDTO struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Platform   string  `json:"platform"`
	AppVersion string  `json:"appVersion"`
	LastSeenAt string  `json:"lastSeenAt"`
	RevokedAt  *string `json:"revokedAt"`
}

type entitlementDTO struct {
	Plan               string         `json:"plan"`
	SubscriptionStatus string         `json:"subscriptionStatus"`
	Features           map[string]any `json:"features"`
	EffectiveUntil     *string        `json:"effectiveUntil"`
}
