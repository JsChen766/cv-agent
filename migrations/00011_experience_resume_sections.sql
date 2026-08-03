-- +goose Up
ALTER TABLE experiences
    ADD COLUMN resume_section_key text,
    ADD COLUMN resume_section_label text,
    ADD CONSTRAINT experiences_resume_section_pair_check
        CHECK ((resume_section_key IS NULL) = (resume_section_label IS NULL)),
    ADD CONSTRAINT experiences_resume_section_key_check
        CHECK (resume_section_key IS NULL OR resume_section_key ~ '^[a-z][a-z0-9-]{0,63}$'),
    ADD CONSTRAINT experiences_resume_section_label_check
        CHECK (resume_section_label IS NULL OR char_length(btrim(resume_section_label)) BETWEEN 1 AND 120),
    ADD CONSTRAINT experiences_resume_section_category_check
        CHECK (category = 'other' OR resume_section_key IS NULL);

-- +goose Down
ALTER TABLE experiences
    DROP CONSTRAINT IF EXISTS experiences_resume_section_category_check,
    DROP CONSTRAINT IF EXISTS experiences_resume_section_label_check,
    DROP CONSTRAINT IF EXISTS experiences_resume_section_key_check,
    DROP CONSTRAINT IF EXISTS experiences_resume_section_pair_check,
    DROP COLUMN IF EXISTS resume_section_label,
    DROP COLUMN IF EXISTS resume_section_key;
