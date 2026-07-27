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
	title := "New"
	valid := Update{ExpectedVersion: 2, Title: &title}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid update, got %v", err)
	}
	if err := (Update{ExpectedVersion: 0}).Validate(); err == nil {
		t.Error("expected error for version < 1")
	}
	blank := "  "
	if err := (Update{ExpectedVersion: 1, Content: &blank}).Validate(); err == nil {
		t.Error("expected error for blank content")
	}
	badCat := Category("nope")
	if err := (Update{ExpectedVersion: 1, Category: &badCat}).Validate(); err == nil {
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
