package httpapi

type requirementDTO struct {
	ID           string   `json:"id"`
	Text         string   `json:"text"`
	Category     string   `json:"category"`
	Importance   string   `json:"importance"`
	Keywords     []string `json:"keywords"`
	Weight       *float64 `json:"weight"`
	V2Importance *string  `json:"v2Importance"`
	V2Category   *string  `json:"v2Category"`
	SortOrder    int      `json:"sortOrder"`
}

type recordDTO struct {
	ID                 string           `json:"id"`
	Title              string           `json:"title"`
	Company            *string          `json:"company"`
	TargetRole         *string          `json:"targetRole"`
	RawText            string           `json:"rawText"`
	Requirements       []requirementDTO `json:"requirements"`
	JdHash             *string          `json:"jdHash"`
	RequirementMapID   *string          `json:"requirementMapId"`
	RequirementsOrigin string           `json:"requirementsOrigin"`
	SourceThreadID     *string          `json:"sourceThreadId"`
	CreatedAt          string           `json:"createdAt"`
	UpdatedAt          string           `json:"updatedAt"`
	SourceKind         string           `json:"sourceKind"`
	SourceURL          *string          `json:"sourceUrl"`
	Status             string           `json:"status"`
	EntityVersion      int64            `json:"entityVersion"`
	DeletedAt          *string          `json:"deletedAt"`
}

type listDTO struct {
	Items      []recordDTO `json:"items"`
	NextCursor *string     `json:"nextCursor"`
}

type requirementRequest struct {
	ID           string   `json:"id"`
	Text         string   `json:"text"`
	Category     string   `json:"category"`
	Importance   string   `json:"importance"`
	Keywords     []string `json:"keywords"`
	V2Importance *string  `json:"v2_importance"`
	V2Category   *string  `json:"v2_category"`
	Weight       *float64 `json:"weight"`
	SortOrder    int      `json:"sort_order"`
}

type createRequest struct {
	ID                 string               `json:"id"`
	Title              string               `json:"title"`
	RawText            string               `json:"raw_text"`
	Company            *string              `json:"company"`
	TargetRole         *string              `json:"target_role"`
	Requirements       []requirementRequest `json:"requirements"`
	SourceKind         string               `json:"source_kind"`
	SourceURL          *string              `json:"source_url"`
	RequirementsOrigin string               `json:"requirements_origin"`
	Status             string               `json:"status"`
}

type updateRequest struct {
	ExpectedVersion int64 `json:"expectedVersion"`
	createRequest
}
