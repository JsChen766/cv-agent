package application

import (
	"context"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/entitlement/domain"
)

// Repository reads the current subscription and plan features for a user.
type Repository interface {
	CurrentSummary(ctx context.Context, userID string, now time.Time) (domain.Summary, error)
}

// Clock returns the current UTC time.
type Clock func() time.Time

// Service exposes the entitlement application use case.
type Service struct {
	repo Repository
	now  Clock
}

// NewService wires the repository.
func NewService(repo Repository, now Clock) *Service {
	return &Service{repo: repo, now: now}
}

// CurrentSummary returns the effective plan for the caller as of now.
func (s *Service) CurrentSummary(ctx context.Context, userID string) (domain.Summary, error) {
	return s.repo.CurrentSummary(ctx, userID, s.now())
}
