-- +goose Up
ALTER TABLE interview_rounds
    ADD CONSTRAINT interview_rounds_user_application_id_id_key
    UNIQUE (user_id, application_id, id);

ALTER TABLE application_notes
    DROP CONSTRAINT application_notes_user_id_interview_round_id_fkey,
    ADD CONSTRAINT application_notes_interview_application_fkey
    FOREIGN KEY (user_id, application_id, interview_round_id)
    REFERENCES interview_rounds(user_id, application_id, id)
    ON DELETE SET NULL (interview_round_id);

ALTER TABLE reminders
    DROP CONSTRAINT reminders_user_id_interview_round_id_fkey,
    ADD CONSTRAINT reminders_interview_application_fkey
    FOREIGN KEY (user_id, application_id, interview_round_id)
    REFERENCES interview_rounds(user_id, application_id, id)
    ON DELETE SET NULL (interview_round_id);

CREATE INDEX applications_status_updated_idx
    ON applications (user_id, status, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX interview_rounds_updated_idx
    ON interview_rounds (user_id, application_id, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX reminders_user_updated_idx
    ON reminders (user_id, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX reminders_status_updated_idx
    ON reminders (user_id, status, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS reminders_status_updated_idx;
DROP INDEX IF EXISTS reminders_user_updated_idx;
DROP INDEX IF EXISTS interview_rounds_updated_idx;
DROP INDEX IF EXISTS applications_status_updated_idx;

ALTER TABLE reminders
    DROP CONSTRAINT reminders_interview_application_fkey,
    ADD CONSTRAINT reminders_user_id_interview_round_id_fkey
    FOREIGN KEY (user_id, interview_round_id)
    REFERENCES interview_rounds(user_id, id)
    ON DELETE SET NULL (interview_round_id);

ALTER TABLE application_notes
    DROP CONSTRAINT application_notes_interview_application_fkey,
    ADD CONSTRAINT application_notes_user_id_interview_round_id_fkey
    FOREIGN KEY (user_id, interview_round_id)
    REFERENCES interview_rounds(user_id, id)
    ON DELETE SET NULL (interview_round_id);

ALTER TABLE interview_rounds
    DROP CONSTRAINT interview_rounds_user_application_id_id_key;
