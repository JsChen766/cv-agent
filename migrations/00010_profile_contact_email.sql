-- +goose Up
ALTER TABLE user_profiles
    ADD COLUMN contact_email text CHECK (char_length(contact_email) <= 320);

-- +goose Down
ALTER TABLE user_profiles DROP COLUMN contact_email;
