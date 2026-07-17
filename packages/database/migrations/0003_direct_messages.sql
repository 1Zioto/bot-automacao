ALTER TABLE messages
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN recipient_phone_snapshot TEXT;

CREATE UNIQUE INDEX messages_tenant_idempotency_uidx
  ON messages (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX messages_direct_queue_idx
  ON messages (instance_id, status, created_at)
  WHERE direction = 'OUTBOUND' AND campaign_id IS NULL;
