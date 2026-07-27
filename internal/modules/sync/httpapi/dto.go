package httpapi

import (
	"encoding/json"
	"time"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
)

type bootstrapRequest struct {
	DeviceID string  `json:"deviceId"`
	Cursor   *string `json:"cursor"`
	Limit    int     `json:"limit"`
}

type pushRequest struct {
	DeviceID   string          `json:"deviceId"`
	Operations []pushOperation `json:"operations"`
}

type pushOperation struct {
	OperationID     string             `json:"operationId"`
	EntityType      syncmod.EntityType `json:"entityType"`
	EntityID        string             `json:"entityId"`
	Action          syncmod.Action     `json:"action"`
	ExpectedVersion *int64             `json:"expectedVersion"`
	Payload         json.RawMessage    `json:"payload"`
}

type operationResultDTO struct {
	OperationID    string               `json:"operationId"`
	Status         syncmod.ResultStatus `json:"status"`
	EntityID       string               `json:"entityId"`
	AppliedVersion *int64               `json:"appliedVersion"`
	ErrorCode      *string              `json:"errorCode,omitempty"`
	ServerEntity   any                  `json:"serverEntity,omitempty"`
}

type pushResultDTO struct {
	Results    []operationResultDTO `json:"results"`
	ServerTime string               `json:"serverTime"`
}

type changeDTO struct {
	EntityType    syncmod.EntityType `json:"entityType"`
	EntityID      string             `json:"entityId"`
	EntityVersion int64              `json:"entityVersion"`
	Operation     syncmod.Operation  `json:"operation"`
	ChangedAt     string             `json:"changedAt"`
	Payload       any                `json:"payload"`
}

type pageDTO struct {
	Changes    []changeDTO `json:"changes"`
	NextCursor string      `json:"nextCursor"`
	HasMore    bool        `json:"hasMore"`
	ServerTime string      `json:"serverTime"`
}

func toPageDTO(page syncmod.Page) pageDTO {
	changes := make([]changeDTO, 0, len(page.Changes))
	for _, change := range page.Changes {
		changes = append(changes, changeDTO{
			EntityType: change.EntityType, EntityID: change.EntityID,
			EntityVersion: change.EntityVersion, Operation: change.Operation,
			ChangedAt: change.ChangedAt.UTC().Format(time.RFC3339Nano),
			Payload:   change.Payload,
		})
	}
	return pageDTO{
		Changes: changes, NextCursor: page.NextCursor, HasMore: page.HasMore,
		ServerTime: page.ServerTime.UTC().Format(time.RFC3339Nano),
	}
}

func toPushResultDTO(result syncmod.PushResult) pushResultDTO {
	items := make([]operationResultDTO, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, operationResultDTO{
			OperationID: item.OperationID, Status: item.Status,
			EntityID: item.EntityID, AppliedVersion: item.AppliedVersion,
			ErrorCode: item.ErrorCode, ServerEntity: item.ServerEntity,
		})
	}
	return pushResultDTO{
		Results:    items,
		ServerTime: result.ServerTime.UTC().Format(time.RFC3339Nano),
	}
}

func toOperations(items []pushOperation) []syncmod.PushOperation {
	operations := make([]syncmod.PushOperation, 0, len(items))
	for _, item := range items {
		operations = append(operations, syncmod.PushOperation{
			OperationID: item.OperationID, EntityType: item.EntityType,
			EntityID: item.EntityID, Action: item.Action,
			ExpectedVersion: item.ExpectedVersion, Payload: item.Payload,
		})
	}
	return operations
}
