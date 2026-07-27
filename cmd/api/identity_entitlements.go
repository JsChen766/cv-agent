package main

import (
	"context"
	"encoding/json"

	entitlementapp "coolto.local/cv-agent-app-be/internal/modules/entitlement/application"
	identityapp "coolto.local/cv-agent-app-be/internal/modules/identity/application"
)

type identityEntitlementReader struct{ service *entitlementapp.Service }

func (r identityEntitlementReader) Current(
	ctx context.Context, userID string,
) (identityapp.EntitlementSummary, error) {
	summary, err := r.service.CurrentSummary(ctx, userID)
	if err != nil {
		return identityapp.EntitlementSummary{}, err
	}
	features := make(map[string]any, len(summary.Features))
	for _, feature := range summary.Features {
		var value any
		if json.Unmarshal(feature.Value, &value) == nil {
			features[feature.Code] = value
		}
	}
	return identityapp.EntitlementSummary{
		Plan: summary.PlanCode, SubscriptionStatus: string(summary.SubscriptionStatus),
		Features: features, EffectiveUntil: summary.EffectiveUntil,
	}, nil
}
