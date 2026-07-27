package sync

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var (
	ErrCursorInvalid   = errors.New("sync cursor is invalid")
	ErrCursorExpired   = errors.New("sync cursor has expired")
	ErrBootstrapNeeded = errors.New("sync bootstrap is required")
)

const (
	cursorVersion = 1
	cursorPull    = "pull"
	cursorBoot    = "bootstrap"
)

type cursorPayload struct {
	Version   int    `json:"v"`
	Kind      string `json:"kind"`
	Position  int64  `json:"position,omitempty"`
	Watermark int64  `json:"watermark,omitempty"`
	TypeIndex int    `json:"typeIndex,omitempty"`
	LastID    string `json:"lastId,omitempty"`
	IssuedAt  int64  `json:"issuedAt"`
}

// CursorCodec signs opaque, user-bound synchronization cursors.
type CursorCodec struct {
	key    []byte
	maxAge time.Duration
	now    func() time.Time
}

func NewCursorCodec(key string, maxAge time.Duration, now func() time.Time) *CursorCodec {
	return &CursorCodec{key: []byte(key), maxAge: maxAge, now: now}
}

func (c *CursorCodec) EncodePull(userID string, position int64) (string, error) {
	return c.encode(userID, cursorPayload{
		Version: cursorVersion, Kind: cursorPull, Position: position,
		IssuedAt: c.now().Unix(),
	})
}

func (c *CursorCodec) DecodePull(userID, token string) (int64, error) {
	if token == "" {
		return 0, ErrBootstrapNeeded
	}
	payload, err := c.decode(userID, token)
	if err != nil {
		return 0, err
	}
	if payload.Kind != cursorPull || payload.Position < 0 {
		return 0, ErrCursorInvalid
	}
	return payload.Position, nil
}

func (c *CursorCodec) EncodeBootstrap(
	userID string,
	watermark int64,
	typeIndex int,
	lastID string,
) (string, error) {
	return c.encode(userID, cursorPayload{
		Version: cursorVersion, Kind: cursorBoot, Watermark: watermark,
		TypeIndex: typeIndex, LastID: lastID, IssuedAt: c.now().Unix(),
	})
}

func (c *CursorCodec) DecodeBootstrap(
	userID string,
	token string,
) (watermark int64, typeIndex int, lastID string, err error) {
	payload, err := c.decode(userID, token)
	if err != nil {
		return 0, 0, "", err
	}
	if payload.Kind != cursorBoot || payload.Watermark < 0 || payload.TypeIndex < 0 {
		return 0, 0, "", ErrCursorInvalid
	}
	return payload.Watermark, payload.TypeIndex, payload.LastID, nil
}

func (c *CursorCodec) encode(userID string, payload cursorPayload) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	signature := c.signature(userID, body)
	return body + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (c *CursorCodec) decode(userID, token string) (cursorPayload, error) {
	body, encodedSignature, ok := strings.Cut(token, ".")
	if !ok || body == "" || encodedSignature == "" || strings.Contains(encodedSignature, ".") {
		return cursorPayload{}, ErrCursorInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil || !hmac.Equal(signature, c.signature(userID, body)) {
		return cursorPayload{}, ErrCursorInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return cursorPayload{}, ErrCursorInvalid
	}
	var payload cursorPayload
	if json.Unmarshal(raw, &payload) != nil || payload.Version != cursorVersion {
		return cursorPayload{}, ErrCursorInvalid
	}
	issuedAt := time.Unix(payload.IssuedAt, 0)
	now := c.now()
	if issuedAt.After(now.Add(5 * time.Minute)) {
		return cursorPayload{}, ErrCursorInvalid
	}
	if now.Sub(issuedAt) > c.maxAge {
		return cursorPayload{}, ErrCursorExpired
	}
	return payload, nil
}

func (c *CursorCodec) signature(userID, body string) []byte {
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write([]byte(userID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(body))
	return mac.Sum(nil)
}
