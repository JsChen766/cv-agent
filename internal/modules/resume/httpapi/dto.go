package httpapi

import "encoding/json"

type summaryDTO struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	TargetRole    *string `json:"targetRole"`
	JdID          *string `json:"jdId"`
	ContentHash   string  `json:"contentHash"`
	SchemaVersion string  `json:"schemaVersion"`
	QualityStatus string  `json:"qualityStatus"`
	Status        string  `json:"status"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
	TargetCompany *string `json:"targetCompany"`
	EntityVersion int64   `json:"entityVersion"`
	DeletedAt     *string `json:"deletedAt"`
}

type fullDTO struct {
	summaryDTO
	Structured         json.RawMessage `json:"structured"`
	Content            string          `json:"content"`
	Score              json.RawMessage `json:"score"`
	EvidenceSummary    json.RawMessage `json:"evidenceSummary"`
	RiskSummary        json.RawMessage `json:"riskSummary"`
	MissingInfo        json.RawMessage `json:"missingInfo"`
	QualityIssues      json.RawMessage `json:"qualityIssues"`
	QualityGateVersion *string         `json:"qualityGateVersion"`
}

type publicationDTO struct {
	fullDTO
	Created        bool    `json:"created"`
	PageUsageRatio float64 `json:"pageUsageRatio"`
}

type listDTO struct {
	Items      []summaryDTO `json:"items"`
	NextCursor *string      `json:"nextCursor"`
}

// publishRequest carries the camelCase outer fields sent by the current APP.
// idempotencyKey, proposalId, sourceFingerprint, evidenceBindings and
// observation are wire-compatibility metadata: they are accepted but not stored
// as separate cloud entities. The backend never runs an LLM.
type publishRequest struct {
	ID                    string          `json:"id"`
	IdempotencyKey        string          `json:"idempotencyKey"`
	ProposalID            string          `json:"proposalId"`
	Title                 string          `json:"title"`
	TargetRole            *string         `json:"targetRole"`
	TargetCompany         *string         `json:"targetCompany"`
	JdID                  *string         `json:"jdId"`
	SourceFingerprint     string          `json:"sourceFingerprint"`
	Structured            json.RawMessage `json:"structured"`
	EvidenceBindings      json.RawMessage `json:"evidenceBindings"`
	Observation           json.RawMessage `json:"observation"`
	ExpectedContentHash   *string         `json:"expectedContentHash"`
	ExpectedEntityVersion *int64          `json:"expectedEntityVersion"`
	SchemaVersion         string          `json:"schemaVersion"`
	Status                string          `json:"status"`
	QualityStatus         string          `json:"qualityStatus"`
	QualityIssues         json.RawMessage `json:"qualityIssues"`
	QualityGateVersion    *string         `json:"qualityGateVersion"`
	Score                 json.RawMessage `json:"score"`
	EvidenceSummary       json.RawMessage `json:"evidenceSummary"`
	RiskSummary           json.RawMessage `json:"riskSummary"`
	MissingInfo           json.RawMessage `json:"missingInfo"`
}

type observation struct {
	UsedHeightPx      *float64 `json:"used_height_px"`
	AvailableHeightPx *float64 `json:"available_height_px"`
}

type patchRequest struct {
	ExpectedVersion int64            `json:"expectedVersion"`
	Title           *string          `json:"title"`
	Status          *string          `json:"status"`
	TargetRole      *json.RawMessage `json:"targetRole"`
	TargetCompany   *json.RawMessage `json:"targetCompany"`
	JdID            *json.RawMessage `json:"jdId"`
}
