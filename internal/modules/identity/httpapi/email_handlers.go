package httpapi

import (
	"net/http"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5/middleware"
)

// RequestEmailChallenge handles POST /v1/auth/email/challenges.
func (h *Handler) RequestEmailChallenge(w http.ResponseWriter, r *http.Request) {
	var req emailChallengeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Purpose != "login" {
		writeBadRequest(w, r, "验证码用途无效")
		return
	}
	accepted, err := h.emailLogin.Request(r.Context(), application.ChallengeRequest{
		ChallengeID: req.ChallengeID, Email: req.Email,
		Device: *req.Device.toInput(), RemoteIP: clientIP(r),
	})
	if err != nil {
		writeDomainError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusAccepted, emailChallengeAcceptedDTO{
		ChallengeID:       accepted.ChallengeID,
		ExpiresAt:         accepted.ExpiresAt.Format(time.RFC3339Nano),
		RetryAfterSeconds: accepted.RetryAfterSeconds,
	}, middleware.GetReqID(r.Context()))
}

// VerifyEmailChallenge handles POST /v1/auth/email/verify.
func (h *Handler) VerifyEmailChallenge(w http.ResponseWriter, r *http.Request) {
	var req emailVerifyRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	issued, err := h.emailLogin.Verify(r.Context(), application.VerifyRequest{
		ChallengeID: req.ChallengeID, Code: req.Code,
		Device: *req.Device.toInput(), RemoteIP: clientIP(r),
	})
	if err != nil {
		writeDomainError(w, r, err)
		return
	}
	summary, err := h.entitlements.Current(r.Context(), issued.User.ID)
	if err != nil {
		writeDomainError(w, r, err)
		return
	}
	h.setSessionCookie(w, issued)
	httpapi.WriteSuccess(w, http.StatusOK, buildEmailLoginResult(issued, summary),
		middleware.GetReqID(r.Context()))
}

func buildEmailLoginResult(
	issued application.IssuedSession, summary application.EntitlementSummary,
) emailLoginResultDTO {
	var revokedAt, effectiveUntil *string
	if issued.Device.RevokedAt != nil {
		value := issued.Device.RevokedAt.UTC().Format(time.RFC3339Nano)
		revokedAt = &value
	}
	if summary.EffectiveUntil != nil {
		value := summary.EffectiveUntil.UTC().Format(time.RFC3339Nano)
		effectiveUntil = &value
	}
	return emailLoginResultDTO{
		User: currentUserDTO{ID: issued.User.ID, Email: issued.User.Email,
			Status: string(issued.User.Status), DeviceID: issued.Device.ID},
		Device: loginDeviceDTO{ID: issued.Device.ID, Name: issued.Device.Name,
			Platform: issued.Device.Platform, AppVersion: issued.Device.AppVersion,
			LastSeenAt: issued.Device.LastSeenAt.UTC().Format(time.RFC3339Nano), RevokedAt: revokedAt},
		Entitlements: entitlementDTO{Plan: summary.Plan,
			SubscriptionStatus: summary.SubscriptionStatus, Features: summary.Features,
			EffectiveUntil: effectiveUntil},
	}
}
