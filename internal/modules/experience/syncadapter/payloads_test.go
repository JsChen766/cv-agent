package syncadapter

import (
	"encoding/json"
	"testing"
)

const completeUpdate = `{
  "revisionId":"019fa941-7cd1-7cb0-9a9e-b0cccf1c7322",
  "category":"work",
  "title":"Engineer",
  "content":"Built sync",
  "organization":null,
  "role":"IC",
  "location":null,
  "startDate":"2024-01",
  "endDate":"present",
  "tags":["Go","Sync"],
  "status":"active",
  "source":"manual"
}`

func TestUpdatePayloadRequiresCompleteState(t *testing.T) {
	var payload updatePayload
	if err := json.Unmarshal([]byte(completeUpdate), &payload); err != nil {
		t.Fatalf("decode complete update: %v", err)
	}
	update := payload.toDomain(3)
	if update.Title != "Engineer" || update.Organization != nil {
		t.Fatalf("unexpected mapped update: %#v", update)
	}
	if update.RevisionID != "019fa941-7cd1-7cb0-9a9e-b0cccf1c7322" {
		t.Fatalf("revision id drifted: %s", update.RevisionID)
	}

	var missing updatePayload
	raw := []byte(`{"revisionId":"019fa941-7cd1-7cb0-9a9e-b0cccf1c7322"}`)
	if err := json.Unmarshal(raw, &missing); err == nil {
		t.Fatal("expected missing full-state fields to fail")
	}
}

func TestLegacyCreatePayloadMayOmitStableRevisionID(t *testing.T) {
	var payload createPayload
	raw := []byte(`{
	  "category":"work","title":"Engineer","content":"Built sync",
	  "organization":null,"role":null,"location":null,
	  "startDate":null,"endDate":null,"tags":[],"status":"active","source":"manual"
	}`)
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("legacy create should remain replayable: %v", err)
	}
	if payload.RevisionID != "" {
		t.Fatalf("unexpected generated wire revision id: %s", payload.RevisionID)
	}
}
