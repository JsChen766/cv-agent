package sync

// EntityType enumerates entities carried on the sync change log.
type EntityType string

const (
	EntityTypeUserProfile            EntityType = "user_profile"
	EntityTypeExperience             EntityType = "experience"
	EntityTypeJobDescription         EntityType = "job_description"
	EntityTypeResume                 EntityType = "resume"
	EntityTypeApplication            EntityType = "application"
	EntityTypeApplicationStatusEvent EntityType = "application_status_event"
	EntityTypeInterviewRound         EntityType = "interview_round"
	EntityTypeApplicationNote        EntityType = "application_note"
	EntityTypeReminder               EntityType = "reminder"
)

// Operation enumerates the wire operation carried on a sync change.
type Operation string

const (
	OperationUpsert Operation = "upsert"
	OperationDelete Operation = "delete"
)
