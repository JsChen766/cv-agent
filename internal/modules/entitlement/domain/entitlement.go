package domain

import (
	"encoding/json"
	"errors"
	"time"
)

var (
	// ErrNoActiveSubscription is returned when a user has no effective subscription.
	ErrNoActiveSubscription = errors.New("no active subscription")
	// ErrDefaultSubscriptionUnavailable means provisioning could not establish
	// an effective subscription, usually because the default plan is inactive.
	ErrDefaultSubscriptionUnavailable = errors.New("default subscription unavailable")
)

// SubscriptionStatus enumerates supported subscription lifecycle states.
type SubscriptionStatus string

const (
	SubscriptionStatusTrialing SubscriptionStatus = "trialing"
	SubscriptionStatusActive   SubscriptionStatus = "active"
	SubscriptionStatusCanceled SubscriptionStatus = "canceled"
	SubscriptionStatusExpired  SubscriptionStatus = "expired"
)

// Feature holds a decoded plan entitlement value.
type Feature struct {
	Code  string
	Value json.RawMessage
}

// Summary aggregates the effective plan for a user.
type Summary struct {
	PlanCode           string
	SubscriptionStatus SubscriptionStatus
	EffectiveUntil     *time.Time
	Features           []Feature
}
