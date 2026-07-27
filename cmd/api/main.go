package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"coolto.local/cv-agent-app-be/internal/modules/entitlement"
	"coolto.local/cv-agent-app-be/internal/modules/identity"
	identityhttp "coolto.local/cv-agent-app-be/internal/modules/identity/httpapi"
	"coolto.local/cv-agent-app-be/internal/modules/profile"
	syncmod "coolto.local/cv-agent-app-be/internal/modules/sync"
	"coolto.local/cv-agent-app-be/internal/platform/cache"
	"coolto.local/cv-agent-app-be/internal/platform/config"
	"coolto.local/cv-agent-app-be/internal/platform/database"
	"coolto.local/cv-agent-app-be/internal/platform/httpserver"

	"github.com/go-chi/chi/v5"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer stop()

	if err := run(ctx, logger); err != nil {
		logger.Error("api stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	db, err := database.Open(ctx, cfg.Database)
	if err != nil {
		return err
	}
	defer db.Close()

	redisClient, err := cache.Open(ctx, cfg.Redis)
	if err != nil {
		return err
	}
	defer redisClient.Close()

	entitlementModule := entitlement.New(db)
	identityModule := identity.New(db, identity.Options{
		DevPasswordLogin: cfg.DevPasswordAuth,
		SecureCookie:     cfg.Environment != "local" && cfg.Environment != "test",
		DeviceNSSalt:     cfg.Environment,
		Provisioner:      entitlementModule.Provisioner,
	})
	recorder := syncmod.NewPgxRecorder()
	profileModule := profile.New(db, recorder)

	authenticated := func(router chi.Router) {
		router.Group(func(secured chi.Router) {
			secured.Use(identityhttp.RequireSession(identityModule.Authenticator()))
			entitlementModule.Handler.Routes(secured)
			profileModule.Handler.Routes(secured)
		})
	}

	handler := httpserver.NewHandler(logger, map[string]httpserver.CheckFunc{
		"postgres": db.Ping,
		"redis": func(ctx context.Context) error {
			return redisClient.Ping(ctx).Err()
		},
	}, identityModule.Registrar(), authenticated)
	server := httpserver.New(cfg.HTTP, handler)
	serverErrors := make(chan error, 1)

	go func() {
		logger.Info("api listening", "address", cfg.HTTP.Address)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(
			context.Background(),
			cfg.ShutdownTimeout,
		)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return errors.Join(ctx.Err(), err)
		}
		return nil
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
