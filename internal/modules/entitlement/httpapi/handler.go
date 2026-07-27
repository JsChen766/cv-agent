package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"coolto.local/cv-agent-app-be/internal/modules/entitlement/application"
	"coolto.local/cv-agent-app-be/internal/modules/entitlement/domain"
	"coolto.local/cv-agent-app-be/internal/platform/authctx"
	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Handler exposes GET /v1/users/me/entitlements.
type Handler struct {
	service *application.Service
}

// NewHandler constructs a Handler.
func NewHandler(service *application.Service) *Handler {
	return &Handler{service: service}
}

// Routes mounts the entitlement endpoint under an authenticated router.
func (h *Handler) Routes(router chi.Router) {
	router.Get("/users/me/entitlements", h.Current)
}

type entitlementDTO struct {
	Plan               string         `json:"plan"`
	SubscriptionStatus string         `json:"subscriptionStatus"`
	Features           map[string]any `json:"features"`
	EffectiveUntil     *string        `json:"effectiveUntil"`
}

// Current handles GET /v1/users/me/entitlements. Authenticated users are
// guaranteed to have an active subscription by the login provisioner, so
// missing rows are treated as a hard server-side inconsistency.
func (h *Handler) Current(w http.ResponseWriter, r *http.Request) {
	principal, ok := authctx.From(r.Context())
	requestID := middleware.GetReqID(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "session_invalid", "会话无效或已过期", requestID)
		return
	}
	summary, err := h.service.CurrentSummary(r.Context(), principal.UserID)
	if err != nil {
		if errors.Is(err, domain.ErrNoActiveSubscription) {
			httpapi.WriteError(w, http.StatusInternalServerError, "no_active_subscription", "订阅未初始化", requestID)
			return
		}
		httpapi.WriteError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误", requestID)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, buildDTO(summary), requestID)
}

func buildDTO(summary domain.Summary) entitlementDTO {
	features := make(map[string]any, len(summary.Features))
	for _, feature := range summary.Features {
		var value any
		if err := json.Unmarshal(feature.Value, &value); err != nil {
			continue
		}
		features[feature.Code] = value
	}
	var effectiveUntil *string
	if summary.EffectiveUntil != nil {
		formatted := summary.EffectiveUntil.UTC().Format("2006-01-02T15:04:05Z07:00")
		effectiveUntil = &formatted
	}
	return entitlementDTO{
		Plan:               summary.PlanCode,
		SubscriptionStatus: string(summary.SubscriptionStatus),
		Features:           features,
		EffectiveUntil:     effectiveUntil,
	}
}
