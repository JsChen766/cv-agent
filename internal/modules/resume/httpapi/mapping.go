package httpapi

import (
	"encoding/json"

	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"
)

const timeLayout = "2006-01-02T15:04:05Z07:00"

func toSummaryDTO(resume domain.Resume) summaryDTO {
	dto := summaryDTO{
		ID: resume.ID, Title: resume.Title, TargetRole: resume.TargetRole,
		JdID: resume.JdID, ContentHash: resume.ContentHash,
		SchemaVersion: resume.SchemaVersion, QualityStatus: string(resume.QualityStatus),
		Status:        string(resume.Status),
		CreatedAt:     resume.CreatedAt.UTC().Format(timeLayout),
		UpdatedAt:     resume.UpdatedAt.UTC().Format(timeLayout),
		TargetCompany: resume.TargetCompany, EntityVersion: resume.EntityVersion,
	}
	if resume.DeletedAt != nil {
		deleted := resume.DeletedAt.UTC().Format(timeLayout)
		dto.DeletedAt = &deleted
	}
	return dto
}

func toFullDTO(resume domain.Resume) fullDTO {
	return fullDTO{
		summaryDTO:         toSummaryDTO(resume),
		Structured:         orEmptyObject(resume.Structured),
		Content:            resume.Content,
		Score:              orDefaultScore(resume.Score),
		EvidenceSummary:    orEmptyArray(resume.EvidenceSummary),
		RiskSummary:        orEmptyArray(resume.RiskSummary),
		MissingInfo:        orEmptyArray(resume.MissingInfo),
		QualityIssues:      orEmptyArray(resume.QualityIssues),
		QualityGateVersion: resume.QualityGateVersion,
	}
}

func toPublicationDTO(resume domain.Resume, created bool, ratio float64) publicationDTO {
	return publicationDTO{fullDTO: toFullDTO(resume), Created: created, PageUsageRatio: ratio}
}

func toPublish(req publishRequest) domain.Publish {
	status := domain.Status(req.Status)
	if status == "" {
		status = domain.StatusActive
	}
	quality := domain.QualityStatus(req.QualityStatus)
	if quality == "" {
		quality = domain.QualityUnverified
	}
	schemaVersion := req.SchemaVersion
	if schemaVersion == "" {
		schemaVersion = domain.DefaultSchemaVersion
	}
	return domain.Publish{
		ID: req.ID, ExpectedVersion: req.ExpectedEntityVersion,
		ExpectedContentHash: req.ExpectedContentHash, Title: req.Title,
		TargetRole: req.TargetRole, TargetCompany: req.TargetCompany, JdID: req.JdID,
		Structured: req.Structured, SchemaVersion: schemaVersion, Status: status,
		QualityStatus: quality, QualityIssues: orEmptyArray(req.QualityIssues),
		QualityGateVersion: req.QualityGateVersion, Score: orEmptyObject(req.Score),
		EvidenceSummary: orEmptyArray(req.EvidenceSummary),
		RiskSummary:     orEmptyArray(req.RiskSummary),
		MissingInfo:     orEmptyArray(req.MissingInfo),
	}
}

func toPatch(req patchRequest) (domain.MetadataPatch, error) {
	patch := domain.MetadataPatch{ExpectedVersion: req.ExpectedVersion, Title: req.Title}
	if req.Status != nil {
		status := domain.Status(*req.Status)
		patch.Status = &status
	}
	for _, field := range []struct {
		raw    *json.RawMessage
		assign func(domain.MetadataPatch, *string) domain.MetadataPatch
	}{
		{req.TargetRole, func(p domain.MetadataPatch, v *string) domain.MetadataPatch {
			p.TargetRole = domain.NewPatchValue(v)
			return p
		}},
		{req.TargetCompany, func(p domain.MetadataPatch, v *string) domain.MetadataPatch {
			p.TargetCompany = domain.NewPatchValue(v)
			return p
		}},
		{req.JdID, func(p domain.MetadataPatch, v *string) domain.MetadataPatch {
			p.JdID = domain.NewPatchValue(v)
			return p
		}},
	} {
		if field.raw == nil {
			continue
		}
		value, err := decodeNullableString(*field.raw)
		if err != nil {
			return domain.MetadataPatch{}, err
		}
		patch = field.assign(patch, value)
	}
	return patch, nil
}

func decodeNullableString(raw json.RawMessage) (*string, error) {
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func pageUsageRatio(req publishRequest) float64 {
	if len(req.Observation) == 0 {
		return 0
	}
	var obs observation
	if err := json.Unmarshal(req.Observation, &obs); err != nil {
		return 0
	}
	if obs.AvailableHeightPx == nil || obs.UsedHeightPx == nil || *obs.AvailableHeightPx == 0 {
		return 0
	}
	return *obs.UsedHeightPx / *obs.AvailableHeightPx
}

func orEmptyObject(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

func orEmptyArray(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`[]`)
	}
	return raw
}

func orDefaultScore(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		return json.RawMessage(`{"overall":0,"relevance":0,"clarity":0,"evidence_strength":0,"quantified_impact":0}`)
	}
	return raw
}
