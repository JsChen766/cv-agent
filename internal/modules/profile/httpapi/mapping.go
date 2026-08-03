package httpapi

import (
	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"
)

const timeLayout = "2006-01-02T15:04:05Z07:00"

func toDTO(profile domain.Profile, email string) profileDTO {
	dto := profileDTO{
		FullName:          profile.FullName,
		ContactEmail:      profile.ContactEmail,
		Phone:             profile.Phone,
		Location:          profile.Location,
		LinkedinURL:       profile.LinkedinURL,
		GithubURL:         profile.GithubURL,
		PersonalWebsite:   profile.PersonalWebsite,
		CurrentTitle:      profile.CurrentTitle,
		CurrentCompany:    profile.CurrentCompany,
		YearsOfExperience: profile.YearsOfExperience,
		CareerStage:       profile.CareerStage,
		TargetRoles:       ensureSlice(profile.TargetRoles),
		TargetIndustries:  ensureSlice(profile.TargetIndustries),
		TargetLocations:   ensureSlice(profile.TargetLocations),
		ResumeStyle:       profile.ResumeStyle,
		EntityVersion:     profile.EntityVersion,
		UpdatedAt:         profile.UpdatedAt.UTC().Format(timeLayout),
	}
	if email != "" {
		copyEmail := email
		dto.Email = &copyEmail
	}
	if profile.PreferredLanguage != "" {
		lang := profile.PreferredLanguage
		dto.PreferredLanguage = &lang
	}
	return dto
}

func fromRequest(req updateRequest) domain.Update {
	return domain.Update{
		ExpectedVersion:   req.ExpectedVersion,
		FullName:          req.FullName,
		ContactEmail:      req.ContactEmail,
		Phone:             req.Phone,
		Location:          req.Location,
		CurrentTitle:      req.CurrentTitle,
		CurrentCompany:    req.CurrentCompany,
		YearsOfExperience: req.YearsOfExperience,
		CareerStage:       req.CareerStage,
		TargetRoles:       ensureSlice(req.TargetRoles),
		TargetIndustries:  ensureSlice(req.TargetIndustries),
		TargetLocations:   ensureSlice(req.TargetLocations),
		PreferredLanguage: req.PreferredLanguage,
		ResumeStyle:       req.ResumeStyle,
		LinkedinURL:       req.LinkedinURL,
		GithubURL:         req.GithubURL,
		PersonalWebsite:   req.PersonalWebsite,
	}
}

func ensureSlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
