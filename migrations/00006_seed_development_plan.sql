-- +goose Up
INSERT INTO plans (id, code, name, status, version, created_at, updated_at)
VALUES (
    '019c0000-0000-7000-8000-000000000001',
    'development',
    'Development',
    'active',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

INSERT INTO plan_entitlements (
    plan_id,
    feature_code,
    value,
    created_at,
    updated_at
)
VALUES
    ('019c0000-0000-7000-8000-000000000001', 'experience.limit', '200', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('019c0000-0000-7000-8000-000000000001', 'jd.limit', '200', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('019c0000-0000-7000-8000-000000000001', 'resume.limit', '100', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('019c0000-0000-7000-8000-000000000001', 'application.limit', '1000', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('019c0000-0000-7000-8000-000000000001', 'sync.enabled', 'true', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- +goose Down
DELETE FROM plans WHERE id = '019c0000-0000-7000-8000-000000000001';
