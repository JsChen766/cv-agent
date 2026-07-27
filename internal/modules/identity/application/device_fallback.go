package application

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
)

const (
	maxDeviceNameLength = 120
	maxAppVersionLength = 40
)

// DeviceFallback carries fields used to synthesize a legacy compatibility
// bucket when the current APP LoginScreen omits device metadata. It is not a
// physical-device identity and must not be reused by the production OTP flow.
type DeviceFallback struct {
	UserAgent string
	RemoteIP  string
	Namespace string
}

// SynthesizeDevice returns a deterministic local/test compatibility bucket.
// Accurate device isolation requires the APP to supply a persisted install ID.
func SynthesizeDevice(userID string, fb DeviceFallback) DeviceInput {
	seed := strings.Join([]string{fb.Namespace, userID, normalize(fb.UserAgent), normalize(fb.RemoteIP)}, "|")
	digest := sha256.Sum256([]byte(seed))
	hexed := hex.EncodeToString(digest[:])

	deviceID := formatDeviceID(hexed)
	return DeviceInput{
		ID:         deviceID,
		Name:       deviceNameFromUA(fb.UserAgent),
		Platform:   detectPlatform(fb.UserAgent),
		AppVersion: "unknown",
	}
}

func normalize(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "-"
	}
	return trimmed
}

// formatDeviceID rewrites a SHA-256 hex digest into a UUIDv7-shaped identifier
// so it satisfies the devices.id uuid column and version/variant nibbles.
func formatDeviceID(hexed string) string {
	bytes := []byte(hexed[:32])
	bytes[12] = '7'
	switch bytes[16] {
	case '8', '9', 'a', 'b':
	default:
		bytes[16] = '8'
	}
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		string(bytes[0:8]),
		string(bytes[8:12]),
		string(bytes[12:16]),
		string(bytes[16:20]),
		string(bytes[20:32]),
	)
}

func detectPlatform(userAgent string) string {
	ua := strings.ToLower(userAgent)
	switch {
	case strings.Contains(ua, "mac"):
		return "macos"
	case strings.Contains(ua, "windows"):
		return "windows"
	case strings.Contains(ua, "linux"):
		return "linux"
	default:
		return "macos"
	}
}

func deviceNameFromUA(userAgent string) string {
	trimmed := strings.TrimSpace(userAgent)
	if trimmed == "" {
		return "CV Agent Client"
	}
	if utf8.RuneCountInString(trimmed) > 100 {
		trimmed = string([]rune(trimmed)[:100])
	}
	return trimmed
}

// ResolveDevice validates a supplied device or falls back to a synthesized one.
func ResolveDevice(userID string, supplied *DeviceInput, fb DeviceFallback) (DeviceInput, error) {
	if supplied == nil {
		return SynthesizeDevice(userID, fb), nil
	}
	device := *supplied
	device.Name = strings.TrimSpace(device.Name)
	device.AppVersion = strings.TrimSpace(device.AppVersion)
	if !id.Valid(device.ID) || device.Name == "" || device.AppVersion == "" {
		return DeviceInput{}, domain.ErrInvalidDeviceInput
	}
	if utf8.RuneCountInString(device.Name) > maxDeviceNameLength ||
		utf8.RuneCountInString(device.AppVersion) > maxAppVersionLength ||
		!domain.ValidPlatform(device.Platform) {
		return DeviceInput{}, domain.ErrInvalidDeviceInput
	}
	return device, nil
}
