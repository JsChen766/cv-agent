package application

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/tracker/domain"
)

// AssetTitleLookup exposes only the cross-module title projection needed by Tracker.
type AssetTitleLookup interface {
	LookupTitle(ctx context.Context, userID, id string) (string, bool, error)
}

func resolveTitle(
	ctx context.Context, lookup AssetTitleLookup, userID string, id *string,
) (*string, error) {
	if id == nil {
		return nil, nil
	}
	title, found, err := lookup.LookupTitle(ctx, userID, *id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.ErrInvalidInput
	}
	return &title, nil
}

func sameOptionalID(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
