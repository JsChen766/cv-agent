package domain

import "testing"

func validRequirementValue() Requirement {
	return Requirement{
		Text: "must know Go", Category: CategoryTechnology,
		Importance: ImportanceMustHave, Keywords: []string{"go"},
	}
}

func validWrite() Write {
	return Write{
		ExpectedVersion: 1, Title: "Backend Engineer", RawText: "build services",
		SourceKind: SourceManual, RequirementsOrigin: OriginManual, Status: StatusActive,
		Requirements: []Requirement{validRequirementValue()},
	}
}

func TestValidateCreate(t *testing.T) {
	if err := validWrite().ValidateCreate(); err != nil {
		t.Fatalf("expected valid create, got %v", err)
	}
	cases := map[string]Write{
		"empty title":   func() Write { w := validWrite(); w.Title = ""; return w }(),
		"blank rawtext": func() Write { w := validWrite(); w.RawText = "  "; return w }(),
		"bad source":    func() Write { w := validWrite(); w.SourceKind = "x"; return w }(),
		"bad origin":    func() Write { w := validWrite(); w.RequirementsOrigin = "x"; return w }(),
		"bad status":    func() Write { w := validWrite(); w.Status = "x"; return w }(),
		"bad req importance": func() Write {
			w := validWrite()
			w.Requirements[0].Importance = "x"
			return w
		}(),
		"bad req category": func() Write {
			w := validWrite()
			w.Requirements[0].Category = "x"
			return w
		}(),
		"bad weight": func() Write {
			w := validWrite()
			bad := 2.0
			w.Requirements[0].Weight = &bad
			return w
		}(),
	}
	for name, input := range cases {
		if err := input.ValidateCreate(); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestValidateReplace(t *testing.T) {
	if err := validWrite().ValidateReplace(); err != nil {
		t.Fatalf("expected valid replace, got %v", err)
	}
	stale := validWrite()
	stale.ExpectedVersion = 0
	if err := stale.ValidateReplace(); err == nil {
		t.Error("expected error for version < 1")
	}
}

func TestValidWeightBounds(t *testing.T) {
	w := validWrite()
	ok := 0.5
	w.Requirements[0].Weight = &ok
	if err := w.ValidateCreate(); err != nil {
		t.Errorf("weight 0.5 should be valid: %v", err)
	}
}
