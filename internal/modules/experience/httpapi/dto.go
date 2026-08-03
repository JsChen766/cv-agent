package httpapi

type revisionDTO struct {
	ID             string  `json:"id"`
	ExperienceID   string  `json:"experienceId"`
	Content        string  `json:"content"`
	Source         string  `json:"source"`
	RevisionHash   *string `json:"revisionHash"`
	FactBankStatus string  `json:"factBankStatus"`
	CreatedAt      string  `json:"createdAt"`
}

type summaryDTO struct {
	ID                 string       `json:"id"`
	Category           string       `json:"category"`
	Title              string       `json:"title"`
	Organization       *string      `json:"organization"`
	Role               *string      `json:"role"`
	Location           *string      `json:"location"`
	StartDate          *string      `json:"startDate"`
	EndDate            *string      `json:"endDate"`
	Tags               []string     `json:"tags"`
	ResumeSectionKey   *string      `json:"resumeSectionKey"`
	ResumeSectionLabel *string      `json:"resumeSectionLabel"`
	Status             string       `json:"status"`
	CurrentRevisionID  *string      `json:"currentRevisionId"`
	CurrentRevision    *revisionDTO `json:"currentRevision"`
	CreatedAt          string       `json:"createdAt"`
	UpdatedAt          string       `json:"updatedAt"`
	EntityVersion      int64        `json:"entityVersion"`
	DeletedAt          *string      `json:"deletedAt"`
}

type detailDTO struct {
	summaryDTO
	Revisions []revisionDTO `json:"revisions"`
}

type listDTO struct {
	Items      []summaryDTO `json:"items"`
	NextCursor *string      `json:"nextCursor"`
}

type revisionListDTO struct {
	Items      []revisionDTO `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

type createRequest struct {
	ID                 string   `json:"id"`
	RevisionID         string   `json:"revisionId"`
	Category           string   `json:"category"`
	Title              string   `json:"title"`
	Content            string   `json:"content"`
	Organization       *string  `json:"organization"`
	Role               *string  `json:"role"`
	Location           *string  `json:"location"`
	StartDate          *string  `json:"start_date"`
	EndDate            *string  `json:"end_date"`
	Tags               []string `json:"tags"`
	ResumeSectionKey   *string  `json:"resumeSectionKey"`
	ResumeSectionLabel *string  `json:"resumeSectionLabel"`
	Status             string   `json:"status"`
	Source             string   `json:"revisionSource"`
}

type updateRequest struct {
	ExpectedVersion    int64    `json:"expectedVersion"`
	RevisionID         *string  `json:"revisionId"`
	Category           string   `json:"category"`
	Title              string   `json:"title"`
	Content            string   `json:"content"`
	Organization       *string  `json:"organization"`
	Role               *string  `json:"role"`
	Location           *string  `json:"location"`
	StartDate          *string  `json:"start_date"`
	EndDate            *string  `json:"end_date"`
	Tags               []string `json:"tags"`
	ResumeSectionKey   *string  `json:"resumeSectionKey"`
	ResumeSectionLabel *string  `json:"resumeSectionLabel"`
	Status             string   `json:"status"`
	Source             string   `json:"revisionSource"`
}
