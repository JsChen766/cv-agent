package pagination

import (
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"coolto.local/cv-agent-app-be/internal/platform/id"
)

// ErrInvalidCursor indicates a malformed keyset cursor.
var ErrInvalidCursor = errors.New("invalid cursor")

// Key is a stable keyset position ordered by (UpdatedAt DESC, ID DESC).
type Key struct {
	UpdatedAt time.Time
	ID        string
}

// Encode renders an opaque cursor for the supplied key.
func Encode(key Key) string {
	raw := strconv.FormatInt(key.UpdatedAt.UTC().UnixNano(), 10) + "|" + key.ID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// Decode parses an opaque cursor. An empty token yields a zero key and ok=false
// so callers can treat it as "from the beginning".
func Decode(token string) (Key, bool, error) {
	if token == "" {
		return Key{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return Key{}, false, ErrInvalidCursor
	}
	nanos, parsedID, ok := strings.Cut(string(raw), "|")
	if !ok || !id.Valid(parsedID) {
		return Key{}, false, ErrInvalidCursor
	}
	unixNano, err := strconv.ParseInt(nanos, 10, 64)
	if err != nil {
		return Key{}, false, ErrInvalidCursor
	}
	return Key{UpdatedAt: time.Unix(0, unixNano).UTC(), ID: parsedID}, true, nil
}
