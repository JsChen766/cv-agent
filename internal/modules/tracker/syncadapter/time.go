package syncadapter

import "time"

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func rfc3339Ptr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	value := t.UTC().Format(time.RFC3339Nano)
	return &value
}
