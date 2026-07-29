package httpapi

import (
	"testing"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
)

func TestRevisionPageUsesLookaheadForExactCursor(t *testing.T) {
	revisions := []domain.Revision{
		{ID: "rev-5", RevisionNumber: 5},
		{ID: "rev-4", RevisionNumber: 4},
		{ID: "rev-3", RevisionNumber: 3},
	}
	page := toRevisionListDTO(revisions, 2)
	if len(page.Items) != 2 {
		t.Fatalf("expected two visible items, got %d", len(page.Items))
	}
	if page.NextCursor == nil || *page.NextCursor != "4" {
		t.Fatalf("expected cursor 4, got %v", page.NextCursor)
	}

	exact := toRevisionListDTO(revisions[:2], 2)
	if exact.NextCursor != nil {
		t.Fatalf("exact final page must not expose a cursor: %v", exact.NextCursor)
	}
}
