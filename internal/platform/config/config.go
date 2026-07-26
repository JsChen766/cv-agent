package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Environment     string
	HTTP            HTTP
	Database        Database
	Redis           Redis
	SMTPAddress     string
	DevPasswordAuth bool
	ShutdownTimeout time.Duration
}

type HTTP struct {
	Address           string
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
}

type Database struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type Redis struct {
	Address  string
	Password string
	DB       int
}

type lookupFunc func(string) (string, bool)

func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup lookupFunc) (Config, error) {
	var cfg Config
	var err error

	cfg.Environment = value(lookup, "APP_ENV", "local")
	cfg.HTTP.Address = value(lookup, "HTTP_ADDRESS", ":8080")
	cfg.HTTP.ReadHeaderTimeout, err = duration(lookup, "HTTP_READ_HEADER_TIMEOUT", "5s")
	if err != nil {
		return Config{}, err
	}
	cfg.HTTP.ReadTimeout, err = duration(lookup, "HTTP_READ_TIMEOUT", "15s")
	if err != nil {
		return Config{}, err
	}
	cfg.HTTP.WriteTimeout, err = duration(lookup, "HTTP_WRITE_TIMEOUT", "30s")
	if err != nil {
		return Config{}, err
	}
	cfg.HTTP.IdleTimeout, err = duration(lookup, "HTTP_IDLE_TIMEOUT", "60s")
	if err != nil {
		return Config{}, err
	}
	cfg.ShutdownTimeout, err = duration(lookup, "SHUTDOWN_TIMEOUT", "10s")
	if err != nil {
		return Config{}, err
	}

	cfg.Database.URL = value(lookup, "DATABASE_URL", "")
	cfg.Database.MaxConns, err = int32Value(lookup, "DATABASE_MAX_CONNS", 20)
	if err != nil {
		return Config{}, err
	}
	cfg.Database.MinConns, err = int32Value(lookup, "DATABASE_MIN_CONNS", 2)
	if err != nil {
		return Config{}, err
	}

	cfg.Redis.Address = value(lookup, "REDIS_ADDRESS", "redis:6379")
	cfg.Redis.Password = value(lookup, "REDIS_PASSWORD", "")
	cfg.Redis.DB, err = intValue(lookup, "REDIS_DB", 0)
	if err != nil {
		return Config{}, err
	}
	cfg.SMTPAddress = value(lookup, "SMTP_ADDRESS", "mailpit:1025")
	cfg.DevPasswordAuth, err = boolValue(lookup, "ENABLE_DEV_PASSWORD_LOGIN", false)
	if err != nil {
		return Config{}, err
	}

	return cfg, cfg.validate()
}

func (cfg Config) validate() error {
	if cfg.Database.URL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if cfg.Database.MinConns < 0 || cfg.Database.MaxConns < 1 {
		return errors.New("database connection limits are invalid")
	}
	if cfg.Database.MinConns > cfg.Database.MaxConns {
		return errors.New("DATABASE_MIN_CONNS cannot exceed DATABASE_MAX_CONNS")
	}
	if cfg.Environment == "production" && cfg.DevPasswordAuth {
		return errors.New("development password login is forbidden in production")
	}
	return nil
}

func value(lookup lookupFunc, key string, fallback string) string {
	if result, ok := lookup(key); ok {
		return result
	}
	return fallback
}

func duration(lookup lookupFunc, key string, fallback string) (time.Duration, error) {
	result, err := time.ParseDuration(value(lookup, key, fallback))
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return result, nil
}

func intValue(lookup lookupFunc, key string, fallback int) (int, error) {
	raw := value(lookup, key, strconv.Itoa(fallback))
	result, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return result, nil
}

func int32Value(lookup lookupFunc, key string, fallback int32) (int32, error) {
	result, err := intValue(lookup, key, int(fallback))
	return int32(result), err
}

func boolValue(lookup lookupFunc, key string, fallback bool) (bool, error) {
	raw := value(lookup, key, strconv.FormatBool(fallback))
	result, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return result, nil
}
