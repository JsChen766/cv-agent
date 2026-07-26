-- +goose Up
-- Development-only seed. NEVER run against staging/production.
-- Password: "devpassword" (Argon2id, do not use in production).
INSERT INTO users (id, status, created_at, updated_at)
VALUES (
    '019c0000-0000-7000-8000-0000000d0e01',
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (id) DO NOTHING;

INSERT INTO user_emails (
    id, user_id, email_normalized, email_display,
    is_primary, verified_at, created_at
) VALUES (
    '019c0000-0000-7000-8000-0000000d0e02',
    '019c0000-0000-7000-8000-0000000d0e01',
    'dev@example.com',
    'dev@example.com',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (email_normalized) DO NOTHING;

INSERT INTO development_password_credentials (
    user_id, password_hash, created_at, updated_at
) VALUES (
    '019c0000-0000-7000-8000-0000000d0e01',
    '$argon2id$v=19$m=65536,t=3,p=2$lYce1yuAXOnrMObTg42OEA$EanqB5iuLUEmuhOR292hkeZE3OM75LZPzBGM92Xjllc',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (user_id) DO NOTHING;

INSERT INTO user_profiles (
    id, user_id, entity_version, created_at, updated_at, preferred_language
) VALUES (
    '019c0000-0000-7000-8000-0000000d0e01',
    '019c0000-0000-7000-8000-0000000d0e01',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    'zh-CN'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (
    id, user_id, plan_id, status, starts_at, created_at, updated_at
) VALUES (
    '019c0000-0000-7000-8000-0000000d0e10',
    '019c0000-0000-7000-8000-0000000d0e01',
    '019c0000-0000-7000-8000-000000000001',
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (id) DO NOTHING;

-- +goose Down
DELETE FROM subscriptions WHERE id = '019c0000-0000-7000-8000-0000000d0e10';
DELETE FROM user_profiles WHERE id = '019c0000-0000-7000-8000-0000000d0e01';
DELETE FROM development_password_credentials
    WHERE user_id = '019c0000-0000-7000-8000-0000000d0e01';
DELETE FROM user_emails WHERE id = '019c0000-0000-7000-8000-0000000d0e02';
DELETE FROM users WHERE id = '019c0000-0000-7000-8000-0000000d0e01';
