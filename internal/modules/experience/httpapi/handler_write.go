package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"coolto.local/cv-agent-app-be/internal/platform/httpapi"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Create creates an experience and its initial revision.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req createRequest
	if err := decodeBody(r.Body, &req); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	exp, err := h.service.Create(r.Context(), principal.UserID, principal.DeviceID, toCreate(req))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusCreated, toDetailDTO(exp), middleware.GetReqID(r.Context()))
}

// Update updates metadata and optionally appends a new revision.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOr401(w, r)
	if !ok {
		return
	}
	var req updateRequest
	if err := decodeBody(r.Body, &req); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "bad_request",
			"请求体格式错误", middleware.GetReqID(r.Context()))
		return
	}
	exp, err := h.service.Replace(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "experienceId"), toUpdate(req),
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toDetailDTO(exp), middleware.GetReqID(r.Context()))
}

// Delete soft-deletes an experience and returns its tombstone summary.
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
	exp, err := h.service.Delete(
		r.Context(), principal.UserID, principal.DeviceID,
		chi.URLParam(r, "experienceId"), expectedVersion,
	)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteSuccess(w, http.StatusOK, toSummaryDTO(exp), middleware.GetReqID(r.Context()))
}

func decodeBody(body io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}
