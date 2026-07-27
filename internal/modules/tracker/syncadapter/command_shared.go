package syncadapter

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
)

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

func applied(version int64, entity any) syncmod.ApplyResult {
	value := version
	return syncmod.ApplyResult{
		Status: syncmod.ResultApplied, AppliedVersion: &value, ServerEntity: entity,
	}
}
