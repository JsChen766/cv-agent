package httpapi

import (
	"encoding/json"
	"net/http"
)

type successEnvelope struct {
	Success   bool   `json:"success"`
	Data      any    `json:"data"`
	RequestID string `json:"request_id,omitempty"`
}

type errorEnvelope struct {
	Success   bool        `json:"success"`
	Error     errorDetail `json:"error"`
	RequestID string      `json:"request_id,omitempty"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func WriteSuccess(
	writer http.ResponseWriter,
	status int,
	data any,
	requestID string,
) {
	writeJSON(writer, status, successEnvelope{
		Success:   true,
		Data:      data,
		RequestID: requestID,
	})
}

func WriteError(
	writer http.ResponseWriter,
	status int,
	code string,
	message string,
	requestID string,
) {
	writeJSON(writer, status, errorEnvelope{
		Success: false,
		Error: errorDetail{
			Code:    code,
			Message: message,
		},
		RequestID: requestID,
	})
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}
