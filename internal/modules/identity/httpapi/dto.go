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
	ID     string `json:"id"`
	Email  string `json:"email"`
	Status string `json:"status"`
}

type logoutResultDTO struct {
	Message string `json:"message"`
}

type revokeSessionsResultDTO struct {
	DeviceID            string `json:"deviceId"`
	RevokedSessionCount int64  `json:"revokedSessionCount"`
}
