package sync

import (
	"reflect"
	"testing"
)

func TestReplayPreservesConflictServerEntity(t *testing.T) {
	version := int64(3)
	server := map[string]any{
		"id":      "019fad39-abb6-7f13-966c-3a9cbc14b523",
		"title":   "Server version",
		"version": float64(3),
	}
	result := replay(
		OperationResult{OperationID: "operation", EntityID: "experience"},
		"request-hash",
		StoredOperation{
			RequestHash:    "request-hash",
			Status:         ResultConflict,
			EntityID:       "experience",
			AppliedVersion: &version,
			ErrorCode:      "entity_version_conflict",
			ServerEntity:   server,
		},
	)

	if result.Status != ResultConflict {
		t.Fatalf("status = %q, want conflict", result.Status)
	}
	if result.ErrorCode == nil || *result.ErrorCode != "entity_version_conflict" {
		t.Fatalf("error code = %v", result.ErrorCode)
	}
	if !reflect.DeepEqual(result.ServerEntity, server) {
		t.Fatalf("server entity = %#v, want %#v", result.ServerEntity, server)
	}
}
