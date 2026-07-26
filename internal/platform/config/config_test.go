package config

import (
	"strings"
	"testing"
)

func TestLoadRejectsDevelopmentPasswordLoginInProduction(t *testing.T) {
	t.Parallel()
	_, err := load(mapLookup(map[string]string{
		"APP_ENV":                   "production",
		"DATABASE_URL":              "postgres://example",
		"ENABLE_DEV_PASSWORD_LOGIN": "true",
	}))
	if err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected production guard error, got %v", err)
	}
}

func TestLoadRejectsInvalidConnectionBounds(t *testing.T) {
	t.Parallel()
	_, err := load(mapLookup(map[string]string{
		"DATABASE_URL":       "postgres://example",
		"DATABASE_MIN_CONNS": "5",
		"DATABASE_MAX_CONNS": "4",
	}))
	if err == nil || !strings.Contains(err.Error(), "cannot exceed") {
		t.Fatalf("expected connection bounds error, got %v", err)
	}
}

func TestLoadAppliesSafeDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := load(mapLookup(map[string]string{
		"DATABASE_URL": "postgres://example",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Environment != "local" || cfg.DevPasswordAuth {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	if cfg.Database.MaxConns != 20 || cfg.Database.MinConns != 2 {
		t.Fatalf("unexpected database defaults: %#v", cfg.Database)
	}
}

func mapLookup(values map[string]string) lookupFunc {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
