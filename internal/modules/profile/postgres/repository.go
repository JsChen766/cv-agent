package postgres

import (
	"context"
	"errors"

	"coolto.local/cv-agent-app-be/internal/modules/profile/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository loads and stores user profiles.
type Repository struct {
	pool *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

const columns = `
id, entity_version, created_at, updated_at, last_modified_device_id,
full_name, phone, location, current_title, current_company,
years_of_experience, career_stage,
target_roles, target_industries, target_locations,
preferred_language, resume_style,
linkedin_url, github_url, personal_website, contact_email`

// Find returns the profile for a user without locking.
func (r *Repository) Find(ctx context.Context, userID string) (domain.Profile, error) {
	row := r.pool.QueryRow(ctx, "SELECT "+columns+" FROM user_profiles WHERE user_id = $1", userID)
	return scanProfile(row)
}

// LoadForUpdate returns the profile inside the supplied transaction with a row lock.
func (r *Repository) LoadForUpdate(ctx context.Context, tx pgx.Tx, userID string) (domain.Profile, error) {
	row := tx.QueryRow(ctx, "SELECT "+columns+" FROM user_profiles WHERE user_id = $1 FOR UPDATE", userID)
	return scanProfile(row)
}

const updateProfile = `
UPDATE user_profiles SET
	    entity_version = $2,
	    updated_at = $3,
	    last_modified_device_id = $4,
	    full_name = $5,
	    contact_email = $6,
	    phone = $7,
	    location = $8,
	    current_title = $9,
	    current_company = $10,
	    years_of_experience = $11,
	    career_stage = $12,
	    target_roles = $13,
	    target_industries = $14,
	    target_locations = $15,
	    preferred_language = $16,
	    resume_style = $17,
	    linkedin_url = $18,
	    github_url = $19,
	    personal_website = $20
WHERE user_id = $1 AND entity_version = $2 - 1`

// Replace applies a new profile row and enforces optimistic locking.
func (r *Repository) Replace(ctx context.Context, tx pgx.Tx, profile domain.Profile) error {
	tag, err := tx.Exec(ctx, updateProfile,
		profile.UserID, profile.EntityVersion, profile.UpdatedAt,
		profile.LastModifiedDeviceID,
		profile.FullName, profile.ContactEmail, profile.Phone, profile.Location,
		profile.CurrentTitle, profile.CurrentCompany,
		profile.YearsOfExperience, profile.CareerStage,
		profile.TargetRoles, profile.TargetIndustries, profile.TargetLocations,
		profile.PreferredLanguage, profile.ResumeStyle,
		profile.LinkedinURL, profile.GithubURL, profile.PersonalWebsite,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrVersionConflict
	}
	return nil
}

func scanProfile(row pgx.Row) (domain.Profile, error) {
	var p domain.Profile
	err := row.Scan(
		&p.UserID, &p.EntityVersion, &p.CreatedAt, &p.UpdatedAt,
		&p.LastModifiedDeviceID,
		&p.FullName, &p.Phone, &p.Location, &p.CurrentTitle, &p.CurrentCompany,
		&p.YearsOfExperience, &p.CareerStage,
		&p.TargetRoles, &p.TargetIndustries, &p.TargetLocations,
		&p.PreferredLanguage, &p.ResumeStyle,
		&p.LinkedinURL, &p.GithubURL, &p.PersonalWebsite, &p.ContactEmail,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Profile{}, domain.ErrProfileNotFound
	}
	if err != nil {
		return domain.Profile{}, err
	}
	return p, nil
}
