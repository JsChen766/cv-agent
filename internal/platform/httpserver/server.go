package httpserver

import (
	"log/slog"
	"net/http"

	"coolto.local/cv-agent-app-be/internal/platform/config"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func NewHandler(
	logger *slog.Logger,
	checks map[string]CheckFunc,
) http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(requestIDHeader)
	router.Use(middleware.Recoverer)
	router.Use(requestLogger(logger))

	health := newHealthHandler(checks)
	router.Get("/health/live", health.live)
	router.Get("/health/ready", health.ready)
	return router
}

func New(cfg config.HTTP, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.Address,
		Handler:           handler,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}
}

func requestIDHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set(
			"X-Request-ID",
			middleware.GetReqID(request.Context()),
		)
		next.ServeHTTP(writer, request)
	})
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			logger.Info(
				"http request",
				"request_id", middleware.GetReqID(request.Context()),
				"method", request.Method,
				"path", request.URL.Path,
			)
			next.ServeHTTP(writer, request)
		})
	}
}
