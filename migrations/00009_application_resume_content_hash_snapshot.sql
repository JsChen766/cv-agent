-- +goose Up
ALTER TABLE applications
    ADD COLUMN resume_content_hash_snapshot text
    CHECK (
        resume_content_hash_snapshot IS NULL
        OR resume_content_hash_snapshot ~ '^[0-9a-f]{64}$'
    );

-- +goose Down
ALTER TABLE applications DROP COLUMN resume_content_hash_snapshot;
