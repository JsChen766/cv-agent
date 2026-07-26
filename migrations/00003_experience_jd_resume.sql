-- +goose Up
CREATE TABLE experiences (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    category text NOT NULL CHECK (category IN ('work', 'project', 'education', 'volunteer', 'other')),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    organization text CHECK (char_length(organization) <= 200),
    role text CHECK (char_length(role) <= 200),
    location text CHECK (char_length(location) <= 200),
    start_date date,
    end_date date,
    tags text[] NOT NULL DEFAULT '{}',
    status text NOT NULL CHECK (status IN ('active', 'archived')),
    current_revision_id uuid,
    UNIQUE (user_id, id),
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id)
);
CREATE INDEX experiences_user_updated_idx
    ON experiences (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX experiences_user_category_status_idx
    ON experiences (user_id, category, status, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX experiences_user_status_idx
    ON experiences (user_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE experience_revisions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    experience_id uuid NOT NULL,
    revision_number integer NOT NULL CHECK (revision_number >= 1),
    content text NOT NULL CHECK (char_length(content) >= 1),
    source text NOT NULL CHECK (source IN ('manual', 'import', 'app_generated')),
    revision_hash text NOT NULL CHECK (revision_hash ~ '^[0-9a-f]{64}$'),
    created_by_device_id uuid,
    created_at timestamptz NOT NULL,
    UNIQUE (experience_id, revision_number),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, experience_id)
        REFERENCES experiences(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, created_by_device_id)
        REFERENCES devices(user_id, id)
);
CREATE INDEX experience_revisions_history_idx
    ON experience_revisions (user_id, experience_id, revision_number DESC);
ALTER TABLE experiences
    ADD FOREIGN KEY (user_id, current_revision_id)
    REFERENCES experience_revisions(user_id, id);

CREATE TABLE job_descriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
    company text CHECK (char_length(company) <= 240),
    target_role text CHECK (char_length(target_role) <= 240),
    source_kind text NOT NULL CHECK (source_kind IN ('manual', 'pasted', 'browser', 'imported')),
    source_url text CHECK (char_length(source_url) <= 4096),
    raw_text text NOT NULL CHECK (char_length(raw_text) >= 1),
    jd_hash text NOT NULL CHECK (jd_hash ~ '^[0-9a-f]{64}$'),
    requirements_origin text NOT NULL CHECK (requirements_origin IN ('manual', 'app_extracted')),
    status text NOT NULL CHECK (status IN ('active', 'archived')),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id)
);
CREATE INDEX job_descriptions_user_updated_idx
    ON job_descriptions (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX job_descriptions_user_status_idx
    ON job_descriptions (user_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX job_descriptions_user_company_idx
    ON job_descriptions (user_id, company, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX job_descriptions_user_hash_idx
    ON job_descriptions (user_id, jd_hash) WHERE deleted_at IS NULL;

CREATE TABLE jd_requirements (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    jd_id uuid NOT NULL,
    text text NOT NULL CHECK (char_length(text) >= 1),
    category text NOT NULL CHECK (
        category IN ('qualification', 'responsibility', 'technology', 'domain', 'soft_skill', 'other')
    ),
    importance text NOT NULL CHECK (importance IN ('must_have', 'preferred', 'optional')),
    keywords text[] NOT NULL DEFAULT '{}',
    weight numeric(6,5) CHECK (weight BETWEEN 0 AND 1),
    sort_order smallint NOT NULL CHECK (sort_order >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (user_id, id),
    UNIQUE (jd_id, sort_order) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (user_id, jd_id)
        REFERENCES job_descriptions(user_id, id) ON DELETE CASCADE
);
CREATE INDEX jd_requirements_order_idx
    ON jd_requirements (user_id, jd_id, sort_order);

CREATE TABLE resumes (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
    target_role text CHECK (char_length(target_role) <= 240),
    target_company text CHECK (char_length(target_company) <= 240),
    jd_id uuid,
    structured jsonb NOT NULL CHECK (jsonb_typeof(structured) = 'object'),
    content text NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 80),
    status text NOT NULL CHECK (status IN ('draft', 'active', 'published', 'archived')),
    quality_status text NOT NULL CHECK (
        quality_status IN ('unverified', 'passed', 'needs_revision', 'failed')
    ),
    quality_issues jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(quality_issues) = 'array'),
    quality_gate_version text,
    score jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(score) = 'object'),
    evidence_summary jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence_summary) = 'array'),
    risk_summary jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(risk_summary) = 'array'),
    missing_info jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(missing_info) = 'array'),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id),
    FOREIGN KEY (user_id, jd_id)
        REFERENCES job_descriptions(user_id, id) ON DELETE SET NULL (jd_id)
);
CREATE INDEX resumes_user_updated_idx
    ON resumes (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX resumes_user_status_idx
    ON resumes (user_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX resumes_user_jd_idx
    ON resumes (user_id, jd_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX resumes_user_hash_idx ON resumes (user_id, content_hash);

-- +goose Down
DROP TABLE IF EXISTS resumes;
DROP TABLE IF EXISTS jd_requirements;
DROP TABLE IF EXISTS job_descriptions;
ALTER TABLE experiences DROP CONSTRAINT IF EXISTS experiences_user_id_current_revision_id_fkey;
DROP TABLE IF EXISTS experience_revisions;
DROP TABLE IF EXISTS experiences;
