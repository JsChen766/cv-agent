package syncadapter

import (
	"encoding/json"

	"coolto.local/cv-agent-app-be/internal/modules/resume/domain"
)

type publishPayload struct {
	Title               string          `json:"title"`
	TargetRole          *string         `json:"targetRole"`
	TargetCompany       *string         `json:"targetCompany"`
	JdID                *string         `json:"jdId"`
	Structured          json.RawMessage `json:"structured"`
	SchemaVersion       string          `json:"schemaVersion"`
	Status              string          `json:"status"`
	QualityStatus       string          `json:"qualityStatus"`
	QualityIssues       json.RawMessage `json:"qualityIssues"`
	QualityGateVersion  *string         `json:"qualityGateVersion"`
	Score               json.RawMessage `json:"score"`
	EvidenceSummary     json.RawMessage `json:"evidenceSummary"`
	RiskSummary         json.RawMessage `json:"riskSummary"`
	MissingInfo         json.RawMessage `json:"missingInfo"`
	ExpectedContentHash *string         `json:"expectedContentHash"`
}

func (p publishPayload) toDomain(expectedVersion *int64) domain.Publish {
	status := domain.Status(p.Status)
	if status == "" {
		status = domain.StatusActive
	}
	quality := domain.QualityStatus(p.QualityStatus)
	if quality == "" {
		quality = domain.QualityUnverified
	}
	schemaVersion := p.SchemaVersion
	if schemaVersion == "" {
		schemaVersion = domain.DefaultSchemaVersion
	}
	return domain.Publish{
		ExpectedVersion: expectedVersion, ExpectedContentHash: p.ExpectedContentHash,
		Title: p.Title, TargetRole: p.TargetRole, TargetCompany: p.TargetCompany,
		JdID: p.JdID, Structured: p.Structured, SchemaVersion: schemaVersion,
		Status: status, QualityStatus: quality, QualityIssues: orEmptyArray(p.QualityIssues),
		QualityGateVersion: p.QualityGateVersion, Score: orEmptyObject(p.Score),
		EvidenceSummary: orEmptyArray(p.EvidenceSummary), RiskSummary: orEmptyArray(p.RiskSummary),
		MissingInfo: orEmptyArray(p.MissingInfo),
	}
}
