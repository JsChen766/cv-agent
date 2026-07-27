package httpapi

import (
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// PublishNew atomically publishes a new full resume document.
func (h *Handler) PublishNew(w http.ResponseWriter, r *http.Request) {
	h.publish(w, r, "")
}

// PublishExisting atomically replaces an existing full resume document.
func (h *Handler) PublishExisting(w http.ResponseWriter, r *http.Request) {
	h.publish(w, r, chi.URLParam(r, "resumeId"))
}

func (h *Handler) publish(w http.ResponseWriter, r *http.Request, resumeID string) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req publishRequest
	if err := decodeBody(r.Body, &req); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	if resumeID != "" {
		req.ID = resumeID
	}
	resume, created, err := h.service.Publish(
		r.Context(), principal.UserID, principal.DeviceID, toPublish(req),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK,
		toPublicationDTO(resume, created, pageUsageRatio(req)),
		middleware.GetReqID(r.Context()))
}

// Patch updates resume metadata under an optimistic lock.
func (h *Handler) Patch(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req patchRequest
	if err := decodeBody(r.Body, &req); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	patch, err := toPatch(req)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	resume, err := h.service.Patch(
		r.Context(), principal.UserID, principal.DeviceID, chi.URLParam(r, "resumeId"), patch,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toFullDTO(resume), middleware.GetReqID(r.Context()))
}

// Delete soft-deletes a resume and returns its tombstone summary.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	expectedVersion, err := strconv.ParseInt(r.URL.Query().Get("expectedVersion"), 10, 64)
	if err != nil || expectedVersion < 1 {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"expectedVersion 不合法", middleware.GetReqID(r.Context()))
		return
	}
	resume, err := h.service.Delete(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "resumeId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toSummaryDTO(resume), middleware.GetReqID(r.Context()))
}
