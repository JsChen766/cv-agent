package id

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// UUID is a 128-bit identifier rendered in canonical form.
type UUID [16]byte

// NewV7 returns a time-ordered UUIDv7 suitable for primary keys.
func NewV7() (UUID, error) {
	var u UUID
	if _, err := rand.Read(u[6:]); err != nil {
		return UUID{}, fmt.Errorf("generate uuid entropy: %w", err)
	}
	ms := uint64(time.Now().UTC().UnixMilli())
	u[0] = byte(ms >> 40)
	u[1] = byte(ms >> 32)
	u[2] = byte(ms >> 24)
	u[3] = byte(ms >> 16)
	u[4] = byte(ms >> 8)
	u[5] = byte(ms)
	u[6] = (u[6] & 0x0f) | 0x70
	u[8] = (u[8] & 0x3f) | 0x80
	return u, nil
}

// String renders the canonical 8-4-4-4-12 form.
func (u UUID) String() string {
	var buf [36]byte
	hex.Encode(buf[0:8], u[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], u[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], u[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], u[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], u[10:16])
	return string(buf[:])
}

// Valid reports whether value is a canonical UUID string. It accepts any UUID
// version because APP installations may already use UUIDv4 while server-owned
// identifiers use UUIDv7.
func Valid(value string) bool {
	if len(value) != 36 ||
		value[8] != '-' || value[13] != '-' ||
		value[18] != '-' || value[23] != '-' {
		return false
	}

	var encoded [32]byte
	copy(encoded[0:8], value[0:8])
	copy(encoded[8:12], value[9:13])
	copy(encoded[12:16], value[14:18])
	copy(encoded[16:20], value[19:23])
	copy(encoded[20:32], value[24:36])
	var decoded [16]byte
	_, err := hex.Decode(decoded[:], encoded[:])
	return err == nil
}
