package application

import (
	"strings"
	"testing"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
)

func TestResolveDeviceFallbackHasStableID(t *testing.T) {
	t.Parallel()
	fb := DeviceFallback{UserAgent: "CV-Agent-App/0.1 (Macintosh; Chrome)", RemoteIP: "127.0.0.1", Namespace: "test"}
	first, err := ResolveDevice("u-1", nil, fb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	second, err := ResolveDevice("u-1", nil, fb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("synthesized id should be stable: %s vs %s", first.ID, second.ID)
	}
	if first.Platform == "" || !domain.ValidPlatform(first.Platform) {
		t.Fatalf("invalid platform: %q", first.Platform)
	}
	if !strings.Contains(first.ID, "-") || len(first.ID) != 36 {
		t.Fatalf("unexpected uuid shape: %q", first.ID)
	}
}

func TestResolveDeviceFallbackDiffersPerUser(t *testing.T) {
	t.Parallel()
	fb := DeviceFallback{UserAgent: "ua", RemoteIP: "1.2.3.4", Namespace: "ns"}
	a, _ := ResolveDevice("u-a", nil, fb)
	b, _ := ResolveDevice("u-b", nil, fb)
	if a.ID == b.ID {
		t.Fatalf("expected per-user divergence")
	}
}

func TestResolveDeviceRejectsIncompleteSupplied(t *testing.T) {
	t.Parallel()
	supplied := &DeviceInput{ID: "", Name: "n", Platform: "macos", AppVersion: "1"}
	_, err := ResolveDevice("u-1", supplied, DeviceFallback{})
	if err != domain.ErrInvalidDeviceInput {
		t.Fatalf("expected invalid device error, got %v", err)
	}
}

func TestResolveDeviceRejectsUnknownPlatform(t *testing.T) {
	t.Parallel()
	supplied := &DeviceInput{
		ID: "019c0000-0000-7000-8000-000000000001", Name: "n",
		Platform: "haiku", AppVersion: "1",
	}
	_, err := ResolveDevice("u-1", supplied, DeviceFallback{})
	if err != domain.ErrInvalidDeviceInput {
		t.Fatalf("expected invalid device error, got %v", err)
	}
}

func TestResolveDeviceRejectsInvalidUUID(t *testing.T) {
	t.Parallel()
	supplied := &DeviceInput{ID: "not-a-uuid", Name: "n", Platform: "macos", AppVersion: "1"}
	_, err := ResolveDevice("u-1", supplied, DeviceFallback{})
	if err != domain.ErrInvalidDeviceInput {
		t.Fatalf("expected invalid device error, got %v", err)
	}
}

func TestResolveDeviceNormalizesMetadata(t *testing.T) {
	t.Parallel()
	supplied := &DeviceInput{
		ID: "019c0000-0000-7000-8000-000000000001", Name: "  Mac  ",
		Platform: "macos", AppVersion: " 1.0 ",
	}
	device, err := ResolveDevice("u-1", supplied, DeviceFallback{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if device.Name != "Mac" || device.AppVersion != "1.0" {
		t.Fatalf("metadata was not normalized: %#v", device)
	}
}
