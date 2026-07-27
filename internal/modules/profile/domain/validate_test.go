package domain

import (
	"strings"
	"testing"
)

func TestUpdateValidateAcceptsChineseWithinRuneLimit(t *testing.T) {
	t.Parallel()
	fullName := strings.Repeat("张", 120)
	update := Update{
		ExpectedVersion:   1,
		FullName:          &fullName,
		PreferredLanguage: "zh-CN",
	}
	if err := update.Validate(); err != nil {
		t.Fatalf("120 Chinese chars should fit rune-limited maxFullName: %v", err)
	}
}

func TestUpdateValidateRejectsExcessRunes(t *testing.T) {
	t.Parallel()
	tooLong := strings.Repeat("张", 121)
	update := Update{
		ExpectedVersion:   1,
		FullName:          &tooLong,
		PreferredLanguage: "zh-CN",
	}
	if err := update.Validate(); err == nil {
		t.Fatalf("expected ErrInvalidInput for oversized fullName")
	}
}

func TestUpdateValidateRejectsEmptyPreferredLanguage(t *testing.T) {
	t.Parallel()
	update := Update{ExpectedVersion: 1, PreferredLanguage: ""}
	if err := update.Validate(); err != ErrInvalidInput {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestUpdateValidateRejectsBadYearsOfExperience(t *testing.T) {
	t.Parallel()
	years := int16(-1)
	update := Update{
		ExpectedVersion:   1,
		YearsOfExperience: &years,
		PreferredLanguage: "zh-CN",
	}
	if err := update.Validate(); err != ErrInvalidInput {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}
