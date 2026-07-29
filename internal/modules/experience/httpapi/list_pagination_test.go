package httpapi

import (
	"testing"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
)

func TestExperiencePageUsesLookaheadForExactCursor(t *testing.T) {
	items := []domain.Experience{
		experienceAt("exp-3", 3),
		experienceAt("exp-2", 2),
		experienceAt("exp-1", 1),
	}
	page := toListDTO(items, 2)
	if len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("expected two items and a cursor: %#v", page)
	}

	exact := toListDTO(items[:2], 2)
	if len(exact.Items) != 2 || exact.NextCursor != nil {
		t.Fatalf("exact final page must not expose a cursor: %#v", exact)
	}
}

func experienceAt(id string, hour int) domain.Experience {
	return domain.Experience{
		ID:        id,
		UpdatedAt: time.Date(2026, time.July, 29, hour, 0, 0, 0, time.UTC),
	}
}
