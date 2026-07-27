package redis

import (
	"context"
	"errors"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/application"

	redisv9 "github.com/redis/go-redis/v9"
)

var fixedWindowScript = redisv9.NewScript(`
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[(i - 1) * 2 + 1])
  local current = tonumber(redis.call('GET', key) or '0')
  if current >= limit then return 0 end
end
for i, key in ipairs(KEYS) do
  local ttl = tonumber(ARGV[(i - 1) * 2 + 2])
  local current = redis.call('INCR', key)
  if current == 1 then redis.call('PEXPIRE', key, ttl) end
end
return 1
`)

// RateLimiter applies multi-dimensional counters in one Redis script.
type RateLimiter struct{ client *redisv9.Client }

func NewRateLimiter(client *redisv9.Client) *RateLimiter {
	return &RateLimiter{client: client}
}

func (r *RateLimiter) Allow(
	ctx context.Context, rules []application.RateLimitRule,
) (bool, error) {
	if len(rules) == 0 {
		return true, nil
	}
	keys := make([]string, 0, len(rules))
	args := make([]any, 0, len(rules)*2)
	for _, rule := range rules {
		if rule.Key == "" || rule.Limit < 1 || rule.Window <= 0 {
			return false, errors.New("invalid rate limit rule")
		}
		keys = append(keys, rule.Key)
		args = append(args, rule.Limit, rule.Window.Milliseconds())
	}
	result, err := fixedWindowScript.Run(ctx, r.client, keys, args...).Int()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

var _ application.RateLimiter = (*RateLimiter)(nil)
var _ = time.Second
