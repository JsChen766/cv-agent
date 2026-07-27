package domain

import (
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
)

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
		!checkOptional(c.EndDate, maxDateText) {
		return ErrInvalidInput
	}
	if !checkTags(c.Tags) {
		return ErrInvalidInput
	}
	return nil
}

// Validate enforces domain constraints for an experience update.
func (u Update) Validate() error {
	if u.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if u.Category != nil && !validCategory(*u.Category) {
		return ErrInvalidInput
	}
	if u.Status != nil && !validStatus(*u.Status) {
		return ErrInvalidInput
	}
	if u.Source != "" && !validSource(u.Source) {
		return ErrInvalidInput
	}
	if u.Title != nil && !validTitle(*u.Title) {
		return ErrInvalidInput
	}
	if u.Content != nil && strings.TrimSpace(*u.Content) == "" {
		return ErrInvalidInput
	}
	if !checkOptional(u.Organization, maxOrganization) ||
		!checkOptional(u.Role, maxRole) ||
		!checkOptional(u.Location, maxLocation) ||
		!checkOptional(u.StartDate, maxDateText) ||
		!checkOptional(u.EndDate, maxDateText) {
		return ErrInvalidInput
	}
	if u.Tags != nil && !checkTags(u.Tags) {
		return ErrInvalidInput
	}
	return nil
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
