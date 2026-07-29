package httpapi

import (
	"strconv"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
	"coolto.local/cv-agent-app-be/internal/platform/pagination"
)

func toListDTO(items []domain.Experience, limit int) listDTO {
	visible := items
	if len(visible) > limit {
		visible = visible[:limit]
	}
	summaries := make([]summaryDTO, 0, len(visible))
	for _, exp := range visible {
		summaries = append(summaries, toSummaryDTO(exp))
	}
	dto := listDTO{Items: summaries}
	if len(items) > limit && limit > 0 {
		last := visible[len(visible)-1]
		cursor := pagination.Encode(pagination.Key{UpdatedAt: last.UpdatedAt, ID: last.ID})
		dto.NextCursor = &cursor
	}
	return dto
}

func toRevisionListDTO(revisions []domain.Revision, limit int) revisionListDTO {
	visible := revisions
	if len(visible) > limit {
		visible = visible[:limit]
	}
	items := make([]revisionDTO, 0, len(visible))
	for _, rev := range visible {
		items = append(items, toRevisionDTO(rev))
	}
	dto := revisionListDTO{Items: items}
	if len(revisions) > limit && limit > 0 {
		cursor := strconv.Itoa(visible[len(visible)-1].RevisionNumber)
		dto.NextCursor = &cursor
	}
	return dto
}
