package syncadapter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"coolto.local/cv-agent-app-be/internal/modules/profile/application"
	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"

	"github.com/jackc/pgx/v5"
)

type CommandHandler struct {
	service *application.Service
}

func NewCommandHandler(service *application.Service) *CommandHandler {
	return &CommandHandler{service: service}
}

func (h *CommandHandler) EntityType() syncmod.EntityType {
	return syncmod.EntityTypeUserProfile
}

func (h *CommandHandler) Apply(
	ctx context.Context,
	tx pgx.Tx,
	command syncmod.Command,
) (syncmod.ApplyResult, error) {
	if command.Action != syncmod.ActionUpdate ||
		command.EntityID != command.UserID ||
		command.ExpectedVersion == nil {
		return failure(syncmod.ResultValidationFailed, "invalid_sync_operation"), nil
	}
	var request updatePayload
	if err := decodePayload(command.Payload, &request); err != nil {
		return failure(syncmod.ResultValidationFailed, "invalid_profile"), nil
	}
	update := request.toDomain(*command.ExpectedVersion)
	profile, err := h.service.ReplaceInTx(
		ctx, tx, command.UserID, command.DeviceID, update,
	)
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrVersionConflict):
			return failure(syncmod.ResultConflict, "entity_version_conflict"), nil
		case errors.Is(err, domain.ErrInvalidInput),
			errors.Is(err, domain.ErrProfileNotFound):
			return failure(syncmod.ResultValidationFailed, "invalid_profile"), nil
		default:
			return syncmod.ApplyResult{}, err
		}
	}
	version := profile.EntityVersion
	projection := toProjection(profile)
	return syncmod.ApplyResult{
		Status: syncmod.ResultApplied, AppliedVersion: &version,
		ServerEntity: projection.Payload,
	}, nil
}

type updatePayload struct {
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

func (p updatePayload) toDomain(expectedVersion int64) domain.Update {
	return domain.Update{
		ExpectedVersion: expectedVersion,
		FullName:        p.FullName, Phone: p.Phone, Location: p.Location,
		LinkedinURL: p.LinkedinURL, GithubURL: p.GithubURL,
		PersonalWebsite: p.PersonalWebsite, CurrentTitle: p.CurrentTitle,
		CurrentCompany: p.CurrentCompany, YearsOfExperience: p.YearsOfExperience,
		CareerStage: p.CareerStage, TargetRoles: slice(p.TargetRoles),
		TargetIndustries:  slice(p.TargetIndustries),
		TargetLocations:   slice(p.TargetLocations),
		PreferredLanguage: p.PreferredLanguage, ResumeStyle: p.ResumeStyle,
	}
}

func decodePayload(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("payload contains trailing JSON")
	}
	return nil
}

func failure(status syncmod.ResultStatus, code string) syncmod.ApplyResult {
	return syncmod.ApplyResult{Status: status, ErrorCode: code}
}
