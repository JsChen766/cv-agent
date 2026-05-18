DELETE FROM api_idempotency_key
WHERE ctid IN (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY user_id, key
        ORDER BY
          CASE WHEN status = 'completed' THEN 0 ELSE 1 END,
          created_at DESC
      ) AS row_number
    FROM api_idempotency_key
  ) ranked
  WHERE ranked.row_number > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_idempotency_user_key_unique
  ON api_idempotency_key(user_id, key);
