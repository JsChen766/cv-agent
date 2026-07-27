package domain

import (
	"regexp"
	"unicode/utf8"

	"coolto.local/cv-agent-app-be/internal/platform/id"
)

const (
	maxName      = 240
	maxTargetURL = 4096
	maxText      = 20000
)

var dedupeKeyPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Validate enforces domain constraints for recording an application.
func (c Create) Validate() error {
	if !validName(c.CompanyName) || !validName(c.RoleName) {
		return ErrInvalidInput
	}
	if !validDeliveryMethod(c.DeliveryMethod) || !validSource(c.Source) {
		return ErrInvalidInput
	}
	if !c.PendingConfirmation && c.AppliedAt == nil {
		return ErrInvalidInput
	}
	if !checkURL(c.TargetURL) {
		return ErrInvalidInput
	}
	if !checkDedupeKey(c.DedupeKey) {
		return ErrInvalidInput
	}
	if !checkText(c.CompanyBusiness) || !checkText(c.RoleSummary) ||
		!checkText(c.CompanyCulture) {
		return ErrInvalidInput
	}
	return nil
}

// Validate enforces domain constraints for a metadata update.
func (u Update) Validate() error {
	if u.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	if !validName(u.CompanyName) || !validName(u.RoleName) {
		return ErrInvalidInput
	}
	if !validDeliveryMethod(u.DeliveryMethod) {
		return ErrInvalidInput
	}
	if !u.PendingConfirmation && u.AppliedAt == nil {
		return ErrInvalidInput
	}
	if !checkURL(u.TargetURL) {
		return ErrInvalidInput
	}
	if !checkText(u.CompanyBusiness) || !checkText(u.RoleSummary) ||
		!checkText(u.CompanyCulture) || !checkText(u.RejectionReason) {
		return ErrInvalidInput
	}
	return nil
}

// Validate enforces domain constraints for a transition command.
func (t Transition) Validate() error {
	if t.ExpectedVersion < 1 || !id.Valid(t.OperationID) {
		return ErrInvalidInput
	}
	if !validStatus(t.ToStatus) {
		return ErrInvalidInput
	}
	if !checkText(t.Reason) {
		return ErrInvalidInput
	}
	return nil
}

func validName(value string) bool {
	length := utf8.RuneCountInString(value)
	return length >= 1 && length <= maxName
}

func checkURL(value *string) bool {
	if value == nil {
		return true
	}
	return utf8.RuneCountInString(*value) <= maxTargetURL
}

func checkText(value *string) bool {
	if value == nil {
		return true
	}
	return utf8.RuneCountInString(*value) <= maxText
}

func checkDedupeKey(value *string) bool {
	if value == nil {
		return true
	}
	return dedupeKeyPattern.MatchString(*value)
}
