package domain

import (
	"errors"
	"time"
)

// Errors mapped to stable HTTP responses.
var (
	ErrProfileNotFound = errors.New("profile not found")
	ErrVersionConflict = errors.New("entity version conflict")
	ErrInvalidInput    = errors.New("invalid profile input")
)

// Profile is the synchronized asset owned by a user. IDs equal user IDs.
type Profile struct {
	UserID               string
	EntityVersion        int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	LastModifiedDeviceID *string
	FullName             *string
	ContactEmail         *string
	Phone                *string
	Location             *string
	CurrentTitle         *string
	CurrentCompany       *string
	YearsOfExperience    *int16
	CareerStage          *string
	TargetRoles          []string
	TargetIndustries     []string
	TargetLocations      []string
	PreferredLanguage    string
	ResumeStyle          *string
	LinkedinURL          *string
	GithubURL            *string
	PersonalWebsite      *string
}

// Update is the atomic PUT payload applied under an optimistic lock.
type Update struct {
	ExpectedVersion   int64
	FullName          *string
	ContactEmail      *string
	Phone             *string
	Location          *string
	CurrentTitle      *string
	CurrentCompany    *string
	YearsOfExperience *int16
	CareerStage       *string
	TargetRoles       []string
	TargetIndustries  []string
	TargetLocations   []string
	PreferredLanguage string
	ResumeStyle       *string
	LinkedinURL       *string
	GithubURL         *string
	PersonalWebsite   *string
}
