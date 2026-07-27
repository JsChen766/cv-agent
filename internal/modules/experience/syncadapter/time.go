package syncadapter

import "time"

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}
