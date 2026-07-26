package security

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
)

const sessionTokenBytes = 32

// SessionToken is a high-entropy opaque token handed to the client. Only its
// hash is ever persisted.
type SessionToken struct {
	value string
}

// NewSessionToken returns a fresh opaque session token whose encoded value
// matches the APP-compatible [A-Za-z0-9._~-]+ character set.
func NewSessionToken() (SessionToken, error) {
	raw := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return SessionToken{}, fmt.Errorf("generate session token: %w", err)
	}
	return SessionToken{value: base64.RawURLEncoding.EncodeToString(raw)}, nil
}

// String returns the opaque token value for transport in the access_token cookie.
func (t SessionToken) String() string {
	return t.value
}

// Hash returns the SHA-256 digest stored in auth_sessions.token_hash.
func (t SessionToken) Hash() []byte {
	return HashSessionValue(t.value)
}

// HashSessionValue hashes an incoming cookie value for constant-shape lookups.
func HashSessionValue(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return digest[:]
}

// ConstantTimeEqualHash compares two session hashes without leaking timing.
func ConstantTimeEqualHash(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}
