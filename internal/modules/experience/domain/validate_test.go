package domain

import "testing"

func ptr(s string) *string { return &s }

func validCreate() Create {
	return Create{
		Category: CategoryWork, Title: "Engineer", Content: "did work",
		Status: StatusActive, Source: SourceManual,
	}
}

func TestCreateValidate(t *testing.T) {
	if err := validCreate().Validate(); err != nil {
		t.Fatalf("expected valid create, got %v", err)
	}
	cases := map[string]Create{
		"bad category": func() Create { c := validCreate(); c.Category = "x"; return c }(),
		"empty title":  func() Create { c := validCreate(); c.Title = ""; return c }(),
		"blank content": func() Create {
			c := validCreate()
			c.Content = "   "
			return c
		}(),
		"bad status": func() Create { c := validCreate(); c.Status = "x"; return c }(),
		"bad source": func() Create { c := validCreate(); c.Source = "x"; return c }(),
		"long org": func() Create {
			c := validCreate()
			org := make([]byte, 201)
			for i := range org {
				org[i] = 'a'
			}
			c.Organization = ptr(string(org))
			return c
		}(),
	}
	for name, input := range cases {
		if err := input.Validate(); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestUpdateValidate(t *testing.T) {
	valid := Update{
		ExpectedVersion: 2, Category: CategoryWork, Title: "New",
		Content: "updated", Status: StatusActive, Source: SourceManual,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid update, got %v", err)
	}
	invalidVersion := valid
	invalidVersion.ExpectedVersion = 0
	if err := invalidVersion.Validate(); err == nil {
		t.Error("expected error for version < 1")
	}
	blank := valid
	blank.Content = "  "
	if err := blank.Validate(); err == nil {
		t.Error("expected error for blank content")
	}
	badCat := valid
	badCat.Category = "nope"
	if err := badCat.Validate(); err == nil {
		t.Error("expected error for bad category")
	}
}

func TestTitleRuneCount(t *testing.T) {
	c := validCreate()
	runes := make([]rune, 200)
	for i := range runes {
		runes[i] = '中'
	}
	c.Title = string(runes)
	if err := c.Validate(); err != nil {
		t.Errorf("200 CJK runes should be valid: %v", err)
	}
	c.Title += "中"
	if err := c.Validate(); err == nil {
		t.Error("201 runes should be invalid")
	}
}

func TestExperienceDatePrecision(t *testing.T) {
	valid := [][2]*string{
		{ptr("2022-01"), ptr("present")},
		{ptr("2022-01"), ptr("2022-01")},
		{ptr("2022-01-31"), ptr("2022-01")},
		{ptr("2022-01"), ptr("2022-01-01")},
	}
	for _, dates := range valid {
		input := validCreate()
		input.StartDate, input.EndDate = dates[0], dates[1]
		if err := input.Validate(); err != nil {
			t.Errorf("expected valid range %q..%q: %v", *dates[0], *dates[1], err)
		}
	}

	invalid := [][2]*string{
		{ptr("2022"), ptr("2023-01")},
		{ptr("2022-02-30"), ptr("present")},
		{ptr("present"), ptr("present")},
		{ptr("2022-02"), ptr("2022-01-31")},
	}
	for _, dates := range invalid {
		input := validCreate()
		input.StartDate, input.EndDate = dates[0], dates[1]
		if err := input.Validate(); err == nil {
			t.Errorf("expected invalid range %q..%q", *dates[0], *dates[1])
		}
	}
}

func TestResumeSectionValidationKeepsCoreCategoriesStable(t *testing.T) {
	valid := validCreate()
	valid.Category = CategoryOther
	valid.ResumeSectionKey = ptr("research-papers")
	valid.ResumeSectionLabel = ptr("Research Papers")
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected open section to be valid: %v", err)
	}
	legacy := validCreate()
	legacy.Category = CategoryOther
	if err := legacy.Validate(); err != nil {
		t.Fatalf("legacy other must remain valid: %v", err)
	}
	for name, input := range map[string]Create{
		"key without label": func() Create { c := valid; c.ResumeSectionLabel = nil; return c }(),
		"custom core category": func() Create {
			c := validCreate()
			c.ResumeSectionKey = ptr("award")
			c.ResumeSectionLabel = ptr("Award")
			return c
		}(),
		"invalid key": func() Create { c := valid; c.ResumeSectionKey = ptr("Not Legal"); return c }(),
	} {
		if err := input.Validate(); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}
