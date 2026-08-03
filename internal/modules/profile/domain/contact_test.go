package domain

import "testing"

func TestUpdateValidateAcceptsContactEmailAndHTTPSURLs(t *testing.T) {
	t.Parallel()
	email := "resume@example.com"
	website := "https://example.com/profile"
	update := Update{
		ExpectedVersion: 1, ContactEmail: &email, LinkedinURL: &website,
		PreferredLanguage: "zh-CN",
	}
	if err := update.Validate(); err != nil {
		t.Fatalf("valid contact fields rejected: %v", err)
	}
}

func TestUpdateValidateRejectsInvalidContactEmailAndURL(t *testing.T) {
	t.Parallel()
	invalidEmail := "resume-at-example.com"
	invalidURL := "http://example.com"
	for _, update := range []Update{
		{ExpectedVersion: 1, ContactEmail: &invalidEmail, PreferredLanguage: "zh-CN"},
		{ExpectedVersion: 1, LinkedinURL: &invalidURL, PreferredLanguage: "zh-CN"},
	} {
		if err := update.Validate(); err != ErrInvalidInput {
			t.Fatalf("invalid contact field error = %v", err)
		}
	}
}
