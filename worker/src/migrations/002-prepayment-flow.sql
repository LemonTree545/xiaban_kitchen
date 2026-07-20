ALTER TABLE orders ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN lookup_token_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN expires_at TEXT;
ALTER TABLE orders ADD COLUMN payment_submitted_at TEXT;
ALTER TABLE orders ADD COLUMN paid_confirmed_at TEXT;
ALTER TABLE orders ADD COLUMN updated_at TEXT;

UPDATE orders
SET status = CASE
      WHEN status = 'pending_review' THEN 'payment_check'
      WHEN status IN ('confirmed','preparing','delivering','done','cancelled') THEN status
      ELSE 'payment_check'
    END,
    paid_confirmed_at = CASE
      WHEN paid = 1 THEN COALESCE(created_at, datetime('now'))
      ELSE paid_confirmed_at
    END,
    updated_at = COALESCE(created_at, datetime('now'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
  ON orders(idempotency_key) WHERE idempotency_key <> '';
CREATE INDEX IF NOT EXISTS idx_orders_status_expires_at
  ON orders(status, expires_at);
