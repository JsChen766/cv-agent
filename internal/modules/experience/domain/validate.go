package domain

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	maxTitle        = 200
	maxOrganization = 200
	maxRole         = 200
	maxLocation     = 200
	maxDateText     = 40
	maxTags         = 40
	maxTagLength    = 80
	maxSectionLabel = 120
)

var sectionKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// Validate enforces domain constraints for a new experience.
func (c Create) Validate() error {
	if !validCategory(c.Category) || !validStatus(c.Status) || !validSource(c.Source) {
		return ErrInvalidInput
	}
	if !validTitle(c.Title) || strings.TrimSpace(c.Content) == "" {
		return ErrInvalidInput
	}
	if !checkOptional(c.Organization, maxOrganization) ||
		!checkOptional(c.Role, maxRole) ||
		!checkOptional(c.Location, maxLocation) ||
		!checkOptional(c.StartDate, maxDateText) ||
		!checkOptional(c.EndDate, maxDateText) ||
		!validExperienceDates(c.StartDate, c.EndDate) {
		return ErrInvalidInput
	}
	if !checkTags(c.Tags) {
		return ErrInvalidInput
	}
	if !checkResumeSection(c.Category, c.ResumeSectionKey, c.ResumeSectionLabel) {
		return ErrInvalidInput
	}
	return nil
}

// Validate enforces domain constraints for an experience update.
func (u Update) Validate() error {
	if u.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if !validCategory(u.Category) || !validStatus(u.Status) {
		return ErrInvalidInput
	}
	if !validSource(u.Source) {
		return ErrInvalidInput
	}
	if !validTitle(u.Title) {
		return ErrInvalidInput
	}
	if strings.TrimSpace(u.Content) == "" {
		return ErrInvalidInput
	}
	if !checkOptional(u.Organization, maxOrganization) ||
		!checkOptional(u.Role, maxRole) ||
		!checkOptional(u.Location, maxLocation) ||
		!checkOptional(u.StartDate, maxDateText) ||
		!checkOptional(u.EndDate, maxDateText) ||
		!validExperienceDates(u.StartDate, u.EndDate) {
		return ErrInvalidInput
	}
	if !checkTags(u.Tags) {
		return ErrInvalidInput
	}
	if !checkResumeSection(u.Category, u.ResumeSectionKey, u.ResumeSectionLabel) {
		return ErrInvalidInput
	}
	return nil
}

func checkResumeSection(category Category, key, label *string) bool {
	if key == nil && label == nil {
		return true
	}
	if category != CategoryOther || key == nil || label == nil {
		return false
	}
	return sectionKeyPattern.MatchString(*key) &&
		utf8.RuneCountInString(strings.TrimSpace(*label)) <= maxSectionLabel &&
		strings.TrimSpace(*label) != ""
}

func validCategory(c Category) bool {
	switch c {
	case CategoryWork, CategoryProject, CategoryEducation, CategoryVolunteer, CategoryOther:
		return true
	default:
		return false
	}
}

func validStatus(s Status) bool {
	return s == StatusActive || s == StatusArchived
}

func validSource(s RevisionSource) bool {
	return s == SourceManual || s == SourceImport || s == SourceAppGenerated
}

func validTitle(title string) bool {
	length := utf8.RuneCountInString(title)
	return length >= 1 && length <= maxTitle
}

func checkOptional(value *string, limit int) bool {
	if value == nil {
		return true
	}
	return utf8.RuneCountInString(*value) <= limit
}

func checkTags(tags []string) bool {
	if len(tags) > maxTags {
		return false
	}
	for _, tag := range tags {
		if strings.TrimSpace(tag) == "" || utf8.RuneCountInString(tag) > maxTagLength {
			return false
		}
	}
	return true
}
