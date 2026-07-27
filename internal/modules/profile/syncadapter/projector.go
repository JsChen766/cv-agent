package syncadapter

import (
	"context"

	"coolto.local/cv-agent-app-be/internal/modules/profile/application"
	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
)

type Projector struct {
	service *application.Service
}

func NewProjector(service *application.Service) *Projector {
	return &Projector{service: service}
}

func (p *Projector) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeUserProfile
}

func (p *Projector) Hydrate(
	ctx context.Context,
	userID string,
	entityIDs []string,
) (map[string]syncmod.Projection, error) {
	result := make(map[string]syncmod.Projection, 1)
	if !contains(entityIDs, userID) {
		return result, nil
	}
	profile, err := p.service.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	result[userID] = toProjection(profile)
	return result, nil
}

func (p *Projector) Bootstrap(
	ctx context.Context,
	userID string,
	afterID string,
	limit int,
) (syncmod.BootstrapPage, error) {
	if limit < 1 || afterID >= userID {
		return syncmod.BootstrapPage{Items: []syncmod.Projection{}}, nil
	}
	profile, err := p.service.Get(ctx, userID)
	if err != nil {
		return syncmod.BootstrapPage{}, err
	}
	return syncmod.BootstrapPage{
		Items: []syncmod.Projection{toProjection(profile)},
	}, nil
}

type payload struct {
	FullName          *string  `json:"fullName"`
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

func toProjection(profile domain.Profile) syncmod.Projection {
	return syncmod.Projection{
		EntityType: syncmod.EntityTypeUserProfile, EntityID: profile.UserID,
		EntityVersion: profile.EntityVersion, UpdatedAt: profile.UpdatedAt,
		Payload: payload{
			FullName: profile.FullName, Phone: profile.Phone, Location: profile.Location,
			LinkedinURL: profile.LinkedinURL, GithubURL: profile.GithubURL,
			PersonalWebsite: profile.PersonalWebsite, CurrentTitle: profile.CurrentTitle,
			CurrentCompany: profile.CurrentCompany, YearsOfExperience: profile.YearsOfExperience,
			CareerStage: profile.CareerStage, TargetRoles: slice(profile.TargetRoles),
			TargetIndustries:  slice(profile.TargetIndustries),
			TargetLocations:   slice(profile.TargetLocations),
			PreferredLanguage: profile.PreferredLanguage, ResumeStyle: profile.ResumeStyle,
		},
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func slice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
