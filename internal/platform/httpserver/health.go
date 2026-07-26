package httpserver

import (
	"context"
	"net/http"
	"time"

	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5/middleware"
)

type CheckFunc func(context.Context) error

type healthHandler struct {
	checks map[string]CheckFunc
}

func newHealthHandler(checks map[string]CheckFunc) healthHandler {
	return healthHandler{checks: checks}
}

func (handler healthHandler) live(
	writer http.ResponseWriter,
	request *http.Request,
) {
	httpapi.WriteSuccess(
		writer,
		http.StatusOK,
		map[string]string{"status": "ok"},
		middleware.GetReqID(request.Context()),
	)
}

func (handler healthHandler) ready(
	writer http.ResponseWriter,
	request *http.Request,
) {
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()

	for name, check := range handler.checks {
		if err := check(ctx); err != nil {
			httpapi.WriteError(
				writer,
				http.StatusServiceUnavailable,
				"dependency_unavailable",
				name+" is unavailable",
				middleware.GetReqID(request.Context()),
			)
			return
		}
	}
	httpapi.WriteSuccess(
		writer,
		http.StatusOK,
		map[string]string{"status": "ready"},
		middleware.GetReqID(request.Context()),
	)
}
