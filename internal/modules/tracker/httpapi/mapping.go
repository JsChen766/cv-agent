package httpapi

import "coolto.local/cv-agent-app-be/internal/modules/tracker/domain"

func toApplicationDTO(a domain.Application) applicationDTO {
	return applicationDTO{
		ID: a.ID, JdID: a.JdID, ResumeID: a.ResumeID,
		CompanyName: a.CompanyName, RoleName: a.RoleName,
		JdTitleSnapshot: a.JdTitleSnapshot, ResumeTitleSnapshot: a.ResumeTitleSnapshot,
		DeliveryMethod: string(a.DeliveryMethod), TargetURL: a.TargetURL,
		AppliedAt: formatOptional(a.AppliedAt), Status: string(a.Status),
		PendingConfirmation: a.PendingConfirmation, Source: string(a.Source),
		DedupeKey: a.DedupeKey, CompanyBusiness: a.CompanyBusiness,
		RoleSummary: a.RoleSummary, CompanyCulture: a.CompanyCulture,
		RejectionReason: a.RejectionReason, EntityVersion: a.EntityVersion,
		CreatedAt: formatTime(a.CreatedAt), UpdatedAt: formatTime(a.UpdatedAt),
		DeletedAt: formatOptional(a.DeletedAt),
	}
}

func toStatusEventDTO(e domain.StatusEvent) statusEventDTO {
	var from *string
	if e.FromStatus != nil {
		value := string(*e.FromStatus)
		from = &value
	}
	return statusEventDTO{
		ID: e.ID, ApplicationID: e.ApplicationID, FromStatus: from,
		ToStatus: string(e.ToStatus), Reason: e.Reason,
		OccurredAt: formatTime(e.OccurredAt), OperationID: e.OperationID,
		CreatedAt: formatTime(e.CreatedAt),
	}
}

func toInterviewDTO(i domain.InterviewRound) interviewDTO {
	return interviewDTO{
		ID: i.ID, ApplicationID: i.ApplicationID, RoundNumber: i.RoundNumber,
		InterviewType: string(i.InterviewType), ScheduledAt: formatOptional(i.ScheduledAt),
		Timezone: i.Timezone, DurationMinutes: i.DurationMinutes,
		LocationOrLink: i.LocationOrLink, Interviewer: i.Interviewer,
		Status: string(i.Status), EntityVersion: i.EntityVersion,
		CreatedAt: formatTime(i.CreatedAt), UpdatedAt: formatTime(i.UpdatedAt),
		DeletedAt: formatOptional(i.DeletedAt),
	}
}

func toNoteDTO(n domain.Note) noteDTO {
	return noteDTO{
		ID: n.ID, ApplicationID: n.ApplicationID, InterviewRoundID: n.InterviewRoundID,
		NoteType: string(n.NoteType), Content: n.Content, EntityVersion: n.EntityVersion,
		CreatedAt: formatTime(n.CreatedAt), UpdatedAt: formatTime(n.UpdatedAt),
		DeletedAt: formatOptional(n.DeletedAt),
	}
}

func toReminderDTO(m domain.Reminder) reminderDTO {
	return reminderDTO{
		ID: m.ID, ApplicationID: m.ApplicationID, InterviewRoundID: m.InterviewRoundID,
		Title: m.Title, RemindAt: formatTime(m.RemindAt), Status: string(m.Status),
		DeliveredAt: formatOptional(m.DeliveredAt), EntityVersion: m.EntityVersion,
		CreatedAt: formatTime(m.CreatedAt), UpdatedAt: formatTime(m.UpdatedAt),
		DeletedAt: formatOptional(m.DeletedAt),
	}
}
