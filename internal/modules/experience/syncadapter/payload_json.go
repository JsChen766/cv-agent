package syncadapter

import (
	"bytes"
	"encoding/json"
	"errors"
)

var createFields = []string{
	"category", "title", "content", "organization", "role",
	"location", "startDate", "endDate", "tags", "status", "source",
}

var updateFields = append([]string{"revisionId"}, createFields...)

func (p *createPayload) UnmarshalJSON(data []byte) error {
	type plain createPayload
	var decoded plain
	if err := decodeComplete(data, createFields, &decoded); err != nil {
		return err
	}
	*p = createPayload(decoded)
	return nil
}

func (p *updatePayload) UnmarshalJSON(data []byte) error {
	type plain updatePayload
	var decoded plain
	if err := decodeComplete(data, updateFields, &decoded); err != nil {
		return err
	}
	*p = updatePayload(decoded)
	return nil
}

func decodeComplete(data []byte, required []string, target any) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, field := range required {
		if _, ok := fields[field]; !ok {
			return errors.New("experience payload is missing " + field)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
