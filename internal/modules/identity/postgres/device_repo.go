package postgres

import (
	"context"
	"errors"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DeviceRepository persists user-owned devices.
type DeviceRepository struct {
	pool *pgxpool.Pool
}

// NewDeviceRepository constructs a DeviceRepository.
func NewDeviceRepository(pool *pgxpool.Pool) *DeviceRepository {
	return &DeviceRepository{pool: pool}
}

const upsertDevice = `
INSERT INTO devices (
    id, user_id, device_name, platform, app_version,
    last_seen_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
ON CONFLICT (id) DO UPDATE SET
    device_name = EXCLUDED.device_name,
    app_version = EXCLUDED.app_version,
    last_seen_at = EXCLUDED.last_seen_at,
    updated_at = EXCLUDED.updated_at
WHERE devices.user_id = EXCLUDED.user_id
RETURNING user_id`

// Upsert registers or refreshes a device for its owning user. Attempting to
// reuse an existing device id under a different user is rejected.
func (r *DeviceRepository) Upsert(ctx context.Context, device domain.Device, now time.Time) error {
	var owner string
	err := r.pool.QueryRow(ctx, upsertDevice,
		device.ID, device.UserID, device.Name, device.Platform, device.AppVersion, now,
	).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrDeviceConflict
	}
	if err != nil {
		return err
	}
	if owner != device.UserID {
		return domain.ErrDeviceConflict
	}
	return nil
}

const selectDevice = `
SELECT id, user_id, device_name, platform, app_version, last_seen_at, revoked_at
FROM devices
WHERE user_id = $1 AND id = $2`

// Find loads a device owned by the given user.
func (r *DeviceRepository) Find(ctx context.Context, userID, deviceID string) (domain.Device, error) {
	var device domain.Device
	err := r.pool.QueryRow(ctx, selectDevice, userID, deviceID).Scan(
		&device.ID, &device.UserID, &device.Name, &device.Platform,
		&device.AppVersion, &device.LastSeenAt, &device.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Device{}, domain.ErrDeviceNotFound
	}
	if err != nil {
		return domain.Device{}, err
	}
	return device, nil
}
