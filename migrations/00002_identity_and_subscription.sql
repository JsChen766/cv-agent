-- +goose Up
CREATE TABLE users (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('active', 'suspended', 'pending_deletion', 'deleted')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    CHECK (deleted_at IS NULL OR status IN ('pending_deletion', 'deleted'))
);

CREATE TABLE user_emails (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email_normalized text NOT NULL UNIQUE,
    email_display text NOT NULL,
    is_primary boolean NOT NULL DEFAULT true,
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX user_emails_one_primary_idx
    ON user_emails (user_id) WHERE is_primary;
CREATE INDEX user_emails_user_created_idx ON user_emails (user_id, created_at);

CREATE TABLE email_login_challenges (
    id uuid PRIMARY KEY,
    email_normalized text NOT NULL,
    purpose text NOT NULL CHECK (purpose = 'login'),
    code_hash bytea NOT NULL,
    delivery_status text NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'failed')),
    attempt_count smallint NOT NULL DEFAULT 0,
    max_attempts smallint NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    request_ip_hash bytea,
    device_fingerprint_hash bytea,
    created_at timestamptz NOT NULL,
    CHECK (max_attempts BETWEEN 1 AND 10),
    CHECK (attempt_count BETWEEN 0 AND max_attempts)
);
CREATE INDEX email_challenges_email_created_idx
    ON email_login_challenges (email_normalized, created_at DESC);
CREATE INDEX email_challenges_expiry_idx
    ON email_login_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE devices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 120),
    platform text NOT NULL CHECK (platform IN ('macos', 'windows', 'linux')),
    app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
    last_seen_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (user_id, id)
);
CREATE INDEX devices_user_active_idx
    ON devices (user_id, revoked_at, last_seen_at DESC);

CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL,
    FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user_validity_idx
    ON auth_sessions (user_id, revoked_at, expires_at);
CREATE INDEX auth_sessions_device_active_idx ON auth_sessions (device_id, revoked_at);

CREATE TABLE development_password_credentials (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE user_profiles (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    last_modified_device_id uuid,
    full_name text CHECK (char_length(full_name) <= 120),
    phone text CHECK (char_length(phone) <= 40),
    location text CHECK (char_length(location) <= 160),
    current_title text CHECK (char_length(current_title) <= 160),
    current_company text CHECK (char_length(current_company) <= 200),
    years_of_experience smallint CHECK (years_of_experience BETWEEN 0 AND 80),
    career_stage text CHECK (char_length(career_stage) <= 40),
    target_roles text[] NOT NULL DEFAULT '{}',
    target_industries text[] NOT NULL DEFAULT '{}',
    target_locations text[] NOT NULL DEFAULT '{}',
    preferred_language text NOT NULL DEFAULT 'zh-CN',
    resume_style text CHECK (char_length(resume_style) <= 40),
    linkedin_url text CHECK (char_length(linkedin_url) <= 2048),
    github_url text CHECK (char_length(github_url) <= 2048),
    personal_website text CHECK (char_length(personal_website) <= 2048),
    UNIQUE (user_id),
    UNIQUE (user_id, id),
    CHECK (id = user_id),
    FOREIGN KEY (user_id, last_modified_device_id)
        REFERENCES devices(user_id, id)
);

CREATE TABLE plans (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'inactive')),
    version integer NOT NULL CHECK (version >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE plan_entitlements (
    plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    feature_code text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (plan_id, feature_code)
);

CREATE TABLE subscriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL REFERENCES plans(id),
    status text NOT NULL CHECK (status IN ('trialing', 'active', 'canceled', 'expired')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE UNIQUE INDEX subscriptions_one_current_idx
    ON subscriptions (user_id) WHERE status IN ('trialing', 'active');
CREATE INDEX subscriptions_user_history_idx
    ON subscriptions (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS plan_entitlements;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS user_profiles;
DROP TABLE IF EXISTS development_password_credentials;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS email_login_challenges;
DROP TABLE IF EXISTS user_emails;
DROP TABLE IF EXISTS users;
