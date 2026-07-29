package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
)

var completeUpdateFields = []string{
	"expectedVersion", "category", "title", "content", "organization", "role",
	"location", "start_date", "end_date", "tags", "status", "revisionSource",
}

func (r *updateRequest) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, field := range completeUpdateFields {
		if _, ok := fields[field]; !ok {
			return errors.New("experience update is missing " + field)
		}
	}
	type plain updateRequest
	var decoded plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*r = updateRequest(decoded)
	return nil
}
