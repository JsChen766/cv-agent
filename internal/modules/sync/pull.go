package sync

import (
	"context"
	"fmt"
	"sort"
	"time"
)

type PullService struct {
	changes    ChangeRepository
	projectors projectorRegistry
	cursors    *CursorCodec
	now        func() time.Time
}

func NewPullService(
	changes ChangeRepository,
	projectors []Projector,
	cursors *CursorCodec,
	now func() time.Time,
) (*PullService, error) {
	registry, err := newProjectorRegistry(projectors)
	if err != nil {
		return nil, err
	}
	return &PullService{
		changes: changes, projectors: registry, cursors: cursors, now: now,
	}, nil
}

func (s *PullService) Pull(
	ctx context.Context,
	userID string,
	cursor string,
	limit int,
) (Page, error) {
	position, err := s.cursors.DecodePull(userID, cursor)
	if err != nil {
		return Page{}, err
	}
	keys, err := s.changes.ListAfter(ctx, userID, position, limit+1)
	if err != nil {
		return Page{}, err
	}
	hasMore := len(keys) > limit
	if hasMore {
		keys = keys[:limit]
	}
	nextPosition := position
	if len(keys) > 0 {
		nextPosition = keys[len(keys)-1].Sequence
	}
	projected, err := s.hydrate(ctx, userID, collapse(keys))
	if err != nil {
		return Page{}, err
	}
	nextCursor, err := s.cursors.EncodePull(userID, nextPosition)
	if err != nil {
		return Page{}, err
	}
	return Page{
		Changes: projected, NextCursor: nextCursor,
		HasMore: hasMore, ServerTime: s.now(),
	}, nil
}

func (s *PullService) hydrate(
	ctx context.Context,
	userID string,
	keys []ChangeKey,
) ([]ProjectedChange, error) {
	grouped := make(map[EntityType][]string)
	for _, key := range keys {
		grouped[key.EntityType] = append(grouped[key.EntityType], key.EntityID)
	}
	projections := make(map[string]Projection, len(keys))
	for entityType, ids := range grouped {
		projector, ok := s.projectors.get(entityType)
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrProjectorMissing, entityType)
		}
		hydrated, err := projector.Hydrate(ctx, userID, ids)
		if err != nil {
			return nil, err
		}
		for id, projection := range hydrated {
			projections[projectionKey(entityType, id)] = projection
		}
	}
	result := make([]ProjectedChange, 0, len(keys))
	for _, key := range keys {
		projection, ok := projections[projectionKey(key.EntityType, key.EntityID)]
		if !ok {
			return nil, fmt.Errorf("%w: %s/%s", ErrProjectionMissing, key.EntityType, key.EntityID)
		}
		result = append(result, toProjectedChange(projection))
	}
	return result, nil
}

func collapse(keys []ChangeKey) []ChangeKey {
	latest := make(map[string]ChangeKey, len(keys))
	for _, key := range keys {
		latest[projectionKey(key.EntityType, key.EntityID)] = key
	}
	result := make([]ChangeKey, 0, len(latest))
	for _, key := range latest {
		result = append(result, key)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Sequence < result[j].Sequence
	})
	return result
}

func projectionKey(entityType EntityType, entityID string) string {
	return string(entityType) + "\x00" + entityID
}
