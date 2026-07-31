package email

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// BrevoSender delivers OTP emails via the Brevo transactional email API.
type BrevoSender struct {
	apiBaseURL  string
	apiKey      string
	templateID  int
	senderEmail string
	senderName  string
	replyTo     string
	httpClient  *http.Client
}

func NewBrevoSender(apiBaseURL, apiKey string, templateID int, senderEmail, senderName, replyTo string) *BrevoSender {
	return &BrevoSender{
		apiBaseURL:  apiBaseURL,
		apiKey:      apiKey,
		templateID:  templateID,
		senderEmail: senderEmail,
		senderName:  senderName,
		replyTo:     replyTo,
		httpClient:  &http.Client{Timeout: 15 * time.Second},
	}
}

func (b *BrevoSender) SendLoginCode(
	ctx context.Context, recipient, code string, expiresIn time.Duration,
) error {
	type emailAddr struct {
		Email string `json:"email"`
		Name  string `json:"name,omitempty"`
	}
	payload := map[string]any{
		"templateId": b.templateID,
		"sender":     emailAddr{Email: b.senderEmail, Name: b.senderName},
		"to":         []emailAddr{{Email: recipient}},
		"params": map[string]any{
			"code":               code,
			"expires_in_minutes": int(expiresIn.Minutes()),
		},
	}
	if b.replyTo != "" {
		payload["replyTo"] = emailAddr{Email: b.replyTo}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		b.apiBaseURL+"/smtp/email", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("api-key", b.apiKey)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")

	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("brevo: HTTP %d — %s", resp.StatusCode, string(data))
	}
	return nil
}
