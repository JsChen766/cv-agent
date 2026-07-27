package sync

import (
	"context"
	"fmt"
	"time"
)

type BootstrapService struct {
	changes    ChangeRepository
	projectors projectorRegistry
	cursors    *CursorCodec
	now        func() time.Time
}

func NewBootstrapService(
	changes ChangeRepository,
	projectors []Projector,
	cursors *CursorCodec,
	now func() time.Time,
) (*BootstrapService, error) {
	registry, err := newProjectorRegistry(projectors)
	if err != nil {
		return nil, err
	}
	return &BootstrapService{
		changes: changes, projectors: registry, cursors: cursors, now: now,
	}, nil
}

func (s *BootstrapService) Bootstrap(
	ctx context.Context,
	userID string,
	cursor string,
	limit int,
) (Page, error) {
	watermark, typeIndex, lastID, err := s.start(ctx, userID, cursor)
	if err != nil {
		return Page{}, err
	}
	if typeIndex > len(s.projectors.ordered) {
		return Page{}, ErrCursorInvalid
	}

	projections := make([]Projection, 0, limit)
	for typeIndex < len(s.projectors.ordered) && len(projections) < limit {
		projector := s.projectors.ordered[typeIndex]
		page, err := projector.Bootstrap(
			ctx, userID, lastID, limit-len(projections),
		)
		if err != nil {
			return Page{}, err
		}
		if err := validateBootstrapPage(projector.EntityType(), page); err != nil {
			return Page{}, err
		}
		projections = append(projections, page.Items...)
		if page.HasMore {
			lastID = page.Items[len(page.Items)-1].EntityID
			return s.intermediate(userID, watermark, typeIndex, lastID, projections)
		}
		typeIndex++
		lastID = ""
	}

	if typeIndex < len(s.projectors.ordered) {
		return s.intermediate(userID, watermark, typeIndex, lastID, projections)
	}
	nextCursor, err := s.cursors.EncodePull(userID, watermark)
	if err != nil {
		return Page{}, err
	}
	return Page{
		Changes: projectChanges(projections), NextCursor: nextCursor,
		HasMore: false, ServerTime: s.now(),
	}, nil
}

func (s *BootstrapService) start(
	ctx context.Context,
	userID string,
	cursor string,
) (int64, int, string, error) {
	if cursor != "" {
		return s.cursors.DecodeBootstrap(userID, cursor)
	}
	watermark, err := s.changes.HighWatermark(ctx, userID)
	return watermark, 0, "", err
}

func (s *BootstrapService) intermediate(
	userID string,
	watermark int64,
	typeIndex int,
	lastID string,
	projections []Projection,
) (Page, error) {
	nextCursor, err := s.cursors.EncodeBootstrap(userID, watermark, typeIndex, lastID)
	if err != nil {
		return Page{}, err
	}
	return Page{
		Changes: projectChanges(projections), NextCursor: nextCursor,
		HasMore: true, ServerTime: s.now(),
	}, nil
}

func projectChanges(projections []Projection) []ProjectedChange {
	changes := make([]ProjectedChange, 0, len(projections))
	for _, projection := range projections {
		changes = append(changes, toProjectedChange(projection))
	}
	return changes
}

func validateBootstrapPage(entityType EntityType, page BootstrapPage) error {
	if page.HasMore && len(page.Items) == 0 {
		return fmt.Errorf("%w: empty page for %s", ErrProjectionMissing, entityType)
	}
	for i, item := range page.Items {
		if item.EntityType != entityType || item.EntityID == "" {
			return fmt.Errorf("%w: invalid %s projection", ErrProjectionMissing, entityType)
		}
		if i > 0 && page.Items[i-1].EntityID >= item.EntityID {
			return fmt.Errorf("%w: unordered %s projection", ErrProjectionMissing, entityType)
		}
	}
	return nil
}
