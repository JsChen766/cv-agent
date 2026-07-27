package domain

import (
	"strings"
	"unicode/utf8"
)

const (
	maxTitle       = 240
	maxCompany     = 240
	maxTargetRole  = 240
	maxSourceURL   = 4096
	maxRequirement = 200
	maxReqText     = 4000
	maxKeywords    = 50
	maxKeywordLen  = 120
)

// ValidateCreate enforces constraints for a new JD.
func (w Write) ValidateCreate() error {
	return w.validate(false)
}

// ValidateReplace enforces constraints for a full JD replace.
func (w Write) ValidateReplace() error {
	if w.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	return w.validate(true)
}

func (w Write) validate(_ bool) error {
	if !validTitle(w.Title) || strings.TrimSpace(w.RawText) == "" {
		return ErrInvalidInput
	}
	if utf8.RuneCountInString(w.RawText) > maxReqText*4 {
		return ErrInvalidInput
	}
	if !validSourceKind(w.SourceKind) || !validOrigin(w.RequirementsOrigin) ||
		!validStatus(w.Status) {
		return ErrInvalidInput
	}
	if !checkOptional(w.Company, maxCompany) ||
		!checkOptional(w.TargetRole, maxTargetRole) ||
		!checkOptional(w.SourceURL, maxSourceURL) {
		return ErrInvalidInput
	}
	if len(w.Requirements) > maxRequirement {
		return ErrInvalidInput
	}
	for _, req := range w.Requirements {
		if !validRequirement(req) {
			return ErrInvalidInput
		}
	}
	return nil
}

func validRequirement(req Requirement) bool {
	if strings.TrimSpace(req.Text) == "" || utf8.RuneCountInString(req.Text) > maxReqText {
		return false
	}
	if !validImportance(req.Importance) || !validCategory(req.Category) {
		return false
	}
	if len(req.Keywords) > maxKeywords {
		return false
	}
	for _, keyword := range req.Keywords {
		if utf8.RuneCountInString(keyword) > maxKeywordLen {
			return false
		}
	}
	if req.Weight != nil && (*req.Weight < 0 || *req.Weight > 1) {
		return false
	}
	return true
}

func validTitle(title string) bool {
	length := utf8.RuneCountInString(title)
	return length >= 1 && length <= maxTitle
}

func validSourceKind(s SourceKind) bool {
	switch s {
	case SourceManual, SourcePasted, SourceBrowser, SourceImported:
		return true
	default:
		return false
	}
}

func validOrigin(o RequirementsOrigin) bool {
	return o == OriginManual || o == OriginAppExtracted
}

func validStatus(s Status) bool {
	return s == StatusActive || s == StatusArchived
}

func validImportance(i Importance) bool {
	return i == ImportanceMustHave || i == ImportancePreferred || i == ImportanceOptional
}

func validCategory(c RequirementCategory) bool {
	switch c {
	case CategoryQualification, CategoryResponsibility, CategoryTechnology,
		CategoryDomain, CategorySoftSkill, CategoryOther:
		return true
	default:
		return false
	}
}

func checkOptional(value *string, limit int) bool {
	if value == nil {
		return true
	}
	return utf8.RuneCountInString(*value) <= limit
}
