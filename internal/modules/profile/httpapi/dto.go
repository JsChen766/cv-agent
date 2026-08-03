package httpapi

type profileDTO struct {
	FullName          *string  `json:"fullName"`
	ContactEmail      *string  `json:"contactEmail"`
	Email             *string  `json:"email"`
	Phone             *string  `json:"phone"`
	Location          *string  `json:"location"`
	LinkedinURL       *string  `json:"linkedinUrl"`
	GithubURL         *string  `json:"githubUrl"`
	PersonalWebsite   *string  `json:"personalWebsite"`
	CurrentTitle      *string  `json:"currentTitle"`
	CurrentCompany    *string  `json:"currentCompany"`
	YearsOfExperience *int16   `json:"yearsOfExperience"`
	CareerStage       *string  `json:"careerStage"`
	TargetRoles       []string `json:"targetRoles"`
	TargetIndustries  []string `json:"targetIndustries"`
	TargetLocations   []string `json:"targetLocations"`
	PreferredLanguage *string  `json:"preferredLanguage"`
	ResumeStyle       *string  `json:"resumeStyle"`
	EntityVersion     int64    `json:"entityVersion"`
	UpdatedAt         string   `json:"updatedAt"`
}

type updateRequest struct {
	ExpectedVersion   int64    `json:"expectedVersion"`
	FullName          *string  `json:"fullName"`
	ContactEmail      *string  `json:"contactEmail"`
	Phone             *string  `json:"phone"`
	Location          *string  `json:"location"`
	LinkedinURL       *string  `json:"linkedinUrl"`
	GithubURL         *string  `json:"githubUrl"`
	PersonalWebsite   *string  `json:"personalWebsite"`
	CurrentTitle      *string  `json:"currentTitle"`
	CurrentCompany    *string  `json:"currentCompany"`
	YearsOfExperience *int16   `json:"yearsOfExperience"`
	CareerStage       *string  `json:"careerStage"`
	TargetRoles       []string `json:"targetRoles"`
	TargetIndustries  []string `json:"targetIndustries"`
	TargetLocations   []string `json:"targetLocations"`
	PreferredLanguage string   `json:"preferredLanguage"`
	ResumeStyle       *string  `json:"resumeStyle"`
}
