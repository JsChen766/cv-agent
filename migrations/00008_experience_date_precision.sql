-- +goose Up
ALTER TABLE experiences
    DROP CONSTRAINT experiences_check,
    ALTER COLUMN start_date TYPE text USING start_date::text,
    ALTER COLUMN end_date TYPE text USING end_date::text,
    ADD CONSTRAINT experiences_start_date_format_check CHECK (
        start_date IS NULL OR start_date ~
        '^[0-9]{4}-(0[1-9]|1[0-2])(-[0-9]{2})?$'
    ),
    ADD CONSTRAINT experiences_end_date_format_check CHECK (
        end_date IS NULL OR end_date = 'present' OR end_date ~
        '^[0-9]{4}-(0[1-9]|1[0-2])(-[0-9]{2})?$'
    );

-- +goose Down
ALTER TABLE experiences
    DROP CONSTRAINT experiences_start_date_format_check,
    DROP CONSTRAINT experiences_end_date_format_check,
    ALTER COLUMN start_date TYPE date USING (
        CASE
            WHEN start_date IS NULL THEN NULL
            WHEN char_length(start_date) = 7 THEN (start_date || '-01')::date
            ELSE start_date::date
        END
    ),
    ALTER COLUMN end_date TYPE date USING (
        CASE
            WHEN end_date IS NULL OR end_date = 'present' THEN NULL
            WHEN char_length(end_date) = 7 THEN
                ((end_date || '-01')::date + interval '1 month - 1 day')::date
            ELSE end_date::date
        END
    ),
    ADD CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
