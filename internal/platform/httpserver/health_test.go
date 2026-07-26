package httpserver

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLivenessUsesCompatibilityEnvelope(t *testing.T) {
	t.Parallel()
	recorder := serve(t, nil, "/health/live")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"success":true`) {
		t.Fatalf("unexpected body: %s", recorder.Body.String())
	}
}

func TestReadinessReportsDependencyFailure(t *testing.T) {
	t.Parallel()
	recorder := serve(t, map[string]CheckFunc{
		"postgres": func(context.Context) error {
			return errors.New("offline")
		},
	}, "/health/ready")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "dependency_unavailable") {
		t.Fatalf("unexpected body: %s", recorder.Body.String())
	}
}

func serve(
	t *testing.T,
	checks map[string]CheckFunc,
	path string,
) *httptest.ResponseRecorder {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	request := httptest.NewRequest(http.MethodGet, path, nil)
	recorder := httptest.NewRecorder()
	NewHandler(logger, checks).ServeHTTP(recorder, request)
	return recorder
}
