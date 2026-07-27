package domain

import (
	"strings"
	"unicode/utf8"
)

const (
	maxFullName        = 120
	maxPhone           = 40
	maxLocation        = 160
	maxCurrentTitle    = 160
	maxCurrentCompany  = 200
	maxCareerStage     = 40
	maxResumeStyle     = 40
	maxURL             = 2048
	maxYearsExperience = 80
	maxItemsList       = 20
	maxItemLength      = 120
	maxLanguage        = 40
)

// Validate enforces domain constraints for a profile update. String lengths
// are measured in runes so multi-byte characters (e.g. Chinese) match the
// OpenAPI schema and the underlying PostgreSQL char_length checks.
func (u Update) Validate() error {
	if u.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if !checkOptional(u.FullName, maxFullName) ||
		!checkOptional(u.Phone, maxPhone) ||
		!checkOptional(u.Location, maxLocation) ||
		!checkOptional(u.CurrentTitle, maxCurrentTitle) ||
		!checkOptional(u.CurrentCompany, maxCurrentCompany) ||
		!checkOptional(u.CareerStage, maxCareerStage) ||
		!checkOptional(u.ResumeStyle, maxResumeStyle) ||
		!checkOptional(u.LinkedinURL, maxURL) ||
		!checkOptional(u.GithubURL, maxURL) ||
		!checkOptional(u.PersonalWebsite, maxURL) {
		return ErrInvalidInput
	}
	if u.YearsOfExperience != nil {
		if *u.YearsOfExperience < 0 || *u.YearsOfExperience > maxYearsExperience {
			return ErrInvalidInput
		}
	}
	if !checkStringList(u.TargetRoles) ||
		!checkStringList(u.TargetIndustries) ||
		!checkStringList(u.TargetLocations) {
		return ErrInvalidInput
	}
	if u.PreferredLanguage == "" || utf8.RuneCountInString(u.PreferredLanguage) > maxLanguage {
		return ErrInvalidInput
	}
	return nil
}

func checkOptional(value *string, limit int) bool {
	if value == nil {
		return true
	}
	return utf8.RuneCountInString(*value) <= limit
}

func checkStringList(values []string) bool {
	if len(values) > maxItemsList {
		return false
	}
	for _, v := range values {
		trimmed := strings.TrimSpace(v)
		if trimmed == "" || utf8.RuneCountInString(v) > maxItemLength {
			return false
		}
	}
	return true
}
