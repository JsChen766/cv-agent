-- +goose Up
CREATE TABLE applications (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    jd_id uuid,
    resume_id uuid,
    company_name text NOT NULL CHECK (char_length(company_name) BETWEEN 1 AND 240),
    role_name text NOT NULL CHECK (char_length(role_name) BETWEEN 1 AND 240),
    jd_title_snapshot text,
    resume_title_snapshot text,
    delivery_method text NOT NULL CHECK (
        delivery_method IN ('form_fill', 'email_fill', 'manual', 'other')
    ),
    target_url text CHECK (char_length(target_url) <= 4096),
    applied_at timestamptz,
    status text NOT NULL CHECK (
        status IN ('applied', 'screening', 'interviewing', 'offer', 'rejected', 'no_response')
    ),
    pending_confirmation boolean NOT NULL DEFAULT false,
    source text NOT NULL CHECK (source IN ('manual', 'browser', 'email', 'other')),
    dedupe_key text CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
    company_business text,
    role_summary text,
    company_culture text,
    rejection_reason text,
    UNIQUE (user_id, id),
    CHECK (pending_confirmation OR applied_at IS NOT NULL),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id),
    FOREIGN KEY (user_id, jd_id)
        REFERENCES job_descriptions(user_id, id) ON DELETE SET NULL (jd_id),
    FOREIGN KEY (user_id, resume_id)
        REFERENCES resumes(user_id, id) ON DELETE SET NULL (resume_id)
);
CREATE INDEX applications_board_idx
    ON applications (user_id, status, applied_at DESC NULLS LAST, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX applications_user_updated_idx
    ON applications (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX applications_user_company_idx
    ON applications (user_id, company_name, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX applications_user_jd_idx
    ON applications (user_id, jd_id) WHERE deleted_at IS NULL;
CREATE INDEX applications_user_resume_idx
    ON applications (user_id, resume_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX applications_user_dedupe_idx
    ON applications (user_id, dedupe_key)
    WHERE deleted_at IS NULL AND dedupe_key IS NOT NULL;

CREATE TABLE application_status_events (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    application_id uuid NOT NULL,
    from_status text CHECK (
        from_status IN ('applied', 'screening', 'interviewing', 'offer', 'rejected', 'no_response')
    ),
    to_status text NOT NULL CHECK (
        to_status IN ('applied', 'screening', 'interviewing', 'offer', 'rejected', 'no_response')
    ),
    reason text,
    occurred_at timestamptz NOT NULL,
    created_by_device_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (user_id, operation_id),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, application_id)
        REFERENCES applications(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, created_by_device_id)
        REFERENCES devices(user_id, id)
);
CREATE INDEX application_status_events_history_idx
    ON application_status_events (user_id, application_id, occurred_at DESC, id DESC);

CREATE TABLE interview_rounds (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    application_id uuid NOT NULL,
    round_number smallint NOT NULL CHECK (round_number >= 1),
    interview_type text NOT NULL CHECK (
        interview_type IN ('phone', 'video', 'onsite', 'hr', 'technical', 'case', 'other')
    ),
    scheduled_at timestamptz,
    timezone text NOT NULL DEFAULT 'Asia/Shanghai',
    duration_minutes smallint CHECK (duration_minutes BETWEEN 1 AND 1440),
    location_or_link text CHECK (char_length(location_or_link) <= 4096),
    interviewer text CHECK (char_length(interviewer) <= 240),
    status text NOT NULL CHECK (status IN ('scheduled', 'completed', 'canceled')),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id),
    FOREIGN KEY (user_id, application_id)
        REFERENCES applications(user_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX interview_rounds_number_idx
    ON interview_rounds (application_id, round_number) WHERE deleted_at IS NULL;
CREATE INDEX interview_rounds_schedule_idx
    ON interview_rounds (user_id, scheduled_at)
    WHERE deleted_at IS NULL AND status = 'scheduled';

CREATE TABLE application_notes (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    application_id uuid NOT NULL,
    interview_round_id uuid,
    note_type text NOT NULL CHECK (note_type IN ('general', 'interview', 'follow_up', 'company')),
    content text NOT NULL,
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id),
    FOREIGN KEY (user_id, application_id)
        REFERENCES applications(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, interview_round_id)
        REFERENCES interview_rounds(user_id, id) ON DELETE SET NULL (interview_round_id)
);
CREATE INDEX application_notes_history_idx
    ON application_notes (user_id, application_id, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE reminders (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    application_id uuid NOT NULL,
    interview_round_id uuid,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
    remind_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('scheduled', 'delivered', 'dismissed', 'canceled')),
    delivered_at timestamptz,
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id),
    FOREIGN KEY (user_id, application_id)
        REFERENCES applications(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, interview_round_id)
        REFERENCES interview_rounds(user_id, id) ON DELETE SET NULL (interview_round_id)
);
CREATE INDEX reminders_schedule_idx
    ON reminders (user_id, remind_at)
    WHERE deleted_at IS NULL AND status = 'scheduled';
CREATE INDEX reminders_application_idx
    ON reminders (user_id, application_id, remind_at DESC) WHERE deleted_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS application_notes;
DROP TABLE IF EXISTS interview_rounds;
DROP TABLE IF EXISTS application_status_events;
DROP TABLE IF EXISTS applications;
