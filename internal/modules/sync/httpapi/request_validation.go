package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"strconv"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/platform/id"
)

func pageLimit(raw string) (int, error) {
	if raw == "" {
		return defaultPageLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maxPageLimit {
		return 0, errors.New("invalid page limit")
	}
	return limit, nil
}

func validPushRequest(request pushRequest) bool {
	if !id.Valid(request.DeviceID) ||
		len(request.Operations) < 1 ||
		len(request.Operations) > maxPushOperations {
		return false
	}
	for _, operation := range request.Operations {
		if !id.Valid(operation.OperationID) || !id.Valid(operation.EntityID) ||
			!validEntityType(operation.EntityType) || !validAction(operation.Action) ||
			len(operation.Payload) == 0 {
			return false
		}
	}
	return true
}

func validAction(action syncmod.Action) bool {
	return action == syncmod.ActionCreate || action == syncmod.ActionUpdate ||
		action == syncmod.ActionDelete || action == syncmod.ActionTransition
}

func validEntityType(entityType syncmod.EntityType) bool {
	switch entityType {
	case syncmod.EntityTypeUserProfile, syncmod.EntityTypeExperience,
		syncmod.EntityTypeJobDescription, syncmod.EntityTypeResume,
		syncmod.EntityTypeApplication, syncmod.EntityTypeApplicationStatusEvent,
		syncmod.EntityTypeInterviewRound, syncmod.EntityTypeApplicationNote,
		syncmod.EntityTypeReminder:
		return true
	default:
		return false
	}
}

func decodeJSON(body io.Reader, limit int64, target any) error {
	decoder := json.NewDecoder(io.LimitReader(body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}
