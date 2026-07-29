package httpapi

import (
	"encoding/json"
	"testing"
)

func TestUpdateRequestDistinguishesNullFromMissing(t *testing.T) {
	raw := []byte(`{
	  "expectedVersion":2,
	  "category":"work",
	  "title":"Engineer",
	  "content":"Built sync",
	  "organization":null,
	  "role":null,
	  "location":null,
	  "start_date":"2024-01",
	  "end_date":"present",
	  "tags":[],
	  "status":"active",
	  "revisionSource":"manual",
	  "revisionId":null
	}`)
	var request updateRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatalf("decode complete update: %v", err)
	}
	if request.Organization != nil || request.Location != nil {
		t.Fatal("explicit null must map to nil")
	}

	deleteLocation := []byte(`{
	  "expectedVersion":2,"category":"work","title":"Engineer","content":"Built sync",
	  "organization":null,"role":null,"start_date":"2024-01","end_date":"present",
	  "tags":[],"status":"active","revisionSource":"manual"
	}`)
	if err := json.Unmarshal(deleteLocation, &request); err == nil {
		t.Fatal("missing nullable location must fail")
	}
}
