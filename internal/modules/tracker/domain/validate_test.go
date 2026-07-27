package domain

import (
	"strings"
	"testing"
	"time"
)

func TestCanTransition(t *testing.T) {
	legal := []struct{ from, to Status }{
		{StatusApplied, StatusScreening},
		{StatusApplied, StatusRejected},
		{StatusApplied, StatusNoResponse},
		{StatusScreening, StatusInterviewing},
		{StatusScreening, StatusRejected},
		{StatusInterviewing, StatusInterviewing},
		{StatusInterviewing, StatusOffer},
		{StatusInterviewing, StatusRejected},
	}
	for _, edge := range legal {
		if !CanTransition(edge.from, edge.to) {
			t.Errorf("expected legal transition %s -> %s", edge.from, edge.to)
		}
	}
	illegal := []struct{ from, to Status }{
		{StatusApplied, StatusInterviewing},
		{StatusApplied, StatusOffer},
		{StatusScreening, StatusOffer},
		{StatusOffer, StatusRejected},
		{StatusRejected, StatusApplied},
		{StatusNoResponse, StatusScreening},
		{StatusApplied, StatusApplied},
	}
	for _, edge := range illegal {
		if CanTransition(edge.from, edge.to) {
			t.Errorf("expected illegal transition %s -> %s", edge.from, edge.to)
		}
	}
}

func TestCanTransitionRejectsInvalidStatus(t *testing.T) {
	if CanTransition(Status("bogus"), StatusApplied) {
		t.Fatal("invalid from-status must not transition")
	}
	if CanTransition(StatusApplied, Status("bogus")) {
		t.Fatal("invalid to-status must not transition")
	}
}

func appliedAt() *time.Time {
	now := time.Now().UTC()
	return &now
}

func TestCreateValidate(t *testing.T) {
	valid := Create{
		CompanyName: "Acme", RoleName: "Engineer",
		DeliveryMethod: DeliveryManual, Source: SourceManual, AppliedAt: appliedAt(),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid create, got %v", err)
	}

	pending := valid
	pending.AppliedAt = nil
	pending.PendingConfirmation = true
	if err := pending.Validate(); err != nil {
		t.Fatalf("pending create without appliedAt should be valid, got %v", err)
	}

	missing := valid
	missing.AppliedAt = nil
	missing.PendingConfirmation = false
	if err := missing.Validate(); err == nil {
		t.Fatal("non-pending create without appliedAt must fail")
	}

	longName := valid
	longName.CompanyName = strings.Repeat("x", maxName+1)
	if err := longName.Validate(); err == nil {
		t.Fatal("over-long company name must fail")
	}

	badMethod := valid
	badMethod.DeliveryMethod = DeliveryMethod("carrier_pigeon")
	if err := badMethod.Validate(); err == nil {
		t.Fatal("invalid delivery method must fail")
	}

	badDedupe := valid
	key := "NOTHEX"
	badDedupe.DedupeKey = &key
	if err := badDedupe.Validate(); err == nil {
		t.Fatal("invalid dedupe key must fail")
	}
}

func TestUpdateValidate(t *testing.T) {
	valid := Update{
		ExpectedVersion: 1, CompanyName: "Acme", RoleName: "Engineer",
		DeliveryMethod: DeliveryManual, AppliedAt: appliedAt(),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid update, got %v", err)
	}
	zeroVersion := valid
	zeroVersion.ExpectedVersion = 0
	if err := zeroVersion.Validate(); err == nil {
		t.Fatal("expectedVersion < 1 must fail")
	}
}

func TestTransitionValidate(t *testing.T) {
	valid := Transition{
		ToStatus: StatusScreening, ExpectedVersion: 1,
		OperationID: "019fcb77-7c45-7b53-8d6a-9f6df5cf27e5",
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid transition, got %v", err)
	}
	bad := Transition{
		ToStatus: Status("bogus"), ExpectedVersion: 1,
		OperationID: "019fcb77-7c45-7b53-8d6a-9f6df5cf27e5",
	}
	if err := bad.Validate(); err == nil {
		t.Fatal("invalid to-status must fail")
	}
}

func TestInterviewWriteValidateDefaultsTimezone(t *testing.T) {
	write := InterviewWrite{RoundNumber: 1, InterviewType: InterviewVideo, Status: InterviewScheduled}
	if err := write.Validate(); err != nil {
		t.Fatalf("expected valid interview, got %v", err)
	}
	if write.Timezone != defaultTimezone {
		t.Fatalf("expected default timezone, got %q", write.Timezone)
	}
	dur := 2000
	over := InterviewWrite{RoundNumber: 1, InterviewType: InterviewVideo, Status: InterviewScheduled, DurationMinutes: &dur}
	if err := over.Validate(); err == nil {
		t.Fatal("duration over 1440 must fail")
	}
	zeroRound := InterviewWrite{RoundNumber: 0, InterviewType: InterviewVideo, Status: InterviewScheduled}
	if err := zeroRound.Validate(); err == nil {
		t.Fatal("round number < 1 must fail")
	}
}

func TestNoteWriteValidate(t *testing.T) {
	valid := NoteWrite{NoteType: NoteGeneral, Content: "hello"}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid note, got %v", err)
	}
	empty := NoteWrite{NoteType: NoteGeneral, Content: ""}
	if err := empty.Validate(); err == nil {
		t.Fatal("empty note content must fail")
	}
	badType := NoteWrite{NoteType: NoteType("scribble"), Content: "hi"}
	if err := badType.Validate(); err == nil {
		t.Fatal("invalid note type must fail")
	}
}

func TestReminderWriteValidate(t *testing.T) {
	valid := ReminderWrite{Title: "Follow up", RemindAt: time.Now().UTC(), Status: ReminderScheduled}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid reminder, got %v", err)
	}
	noTime := ReminderWrite{Title: "Follow up", Status: ReminderScheduled}
	if err := noTime.Validate(); err == nil {
		t.Fatal("reminder without remindAt must fail")
	}
	emptyTitle := ReminderWrite{Title: "", RemindAt: time.Now().UTC(), Status: ReminderScheduled}
	if err := emptyTitle.Validate(); err == nil {
		t.Fatal("empty reminder title must fail")
	}
}
