-- +goose Up
CREATE TABLE sync_changes (
    change_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (
        entity_type IN (
            'user_profile', 'experience', 'job_description', 'resume', 'application',
            'application_status_event', 'interview_round', 'application_note', 'reminder'
        )
    ),
    entity_id uuid NOT NULL,
    entity_version bigint NOT NULL CHECK (entity_version >= 1),
    operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
    changed_at timestamptz NOT NULL,
    UNIQUE (user_id, entity_type, entity_id, entity_version)
);
CREATE INDEX sync_changes_pull_idx ON sync_changes (user_id, change_seq);
CREATE INDEX sync_changes_retention_idx ON sync_changes (changed_at);

CREATE TABLE sync_operations (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    device_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'transition')),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    result_status text NOT NULL CHECK (
        result_status IN ('applied', 'conflict', 'validation_failed', 'forbidden')
    ),
    applied_version bigint CHECK (applied_version >= 1),
    result_metadata jsonb NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(result_metadata) = 'object'),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, operation_id),
    CHECK (expires_at > created_at),
    FOREIGN KEY (user_id, device_id)
        REFERENCES devices(user_id, id)
);
CREATE INDEX sync_operations_expiry_idx ON sync_operations (expires_at);

CREATE TABLE http_idempotency_records (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope text NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status smallint NOT NULL CHECK (response_status BETWEEN 200 AND 599),
    result_metadata jsonb NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(result_metadata) = 'object'),
    resource_type text,
    resource_id uuid,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, scope, idempotency_key),
    CHECK (expires_at > created_at)
);
CREATE INDEX http_idempotency_expiry_idx ON http_idempotency_records (expires_at);

-- +goose Down
DROP TABLE IF EXISTS http_idempotency_records;
DROP TABLE IF EXISTS sync_operations;
DROP TABLE IF EXISTS sync_changes;
