CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DELETED')),
  last_login_at TIMESTAMPTZ,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug CITEXT NOT NULL UNIQUE,
  document TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELED', 'DELETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (id, status)
);

CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'OPERATOR', 'ANALYST')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED')),
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  monthly_price NUMERIC(12, 2) NOT NULL CHECK (monthly_price >= 0),
  max_instances INTEGER NOT NULL CHECK (max_instances > 0),
  max_users INTEGER NOT NULL CHECK (max_users > 0),
  daily_messages_per_instance INTEGER NOT NULL CHECK (daily_messages_per_instance > 0),
  max_active_lists INTEGER CHECK (max_active_lists IS NULL OR max_active_lists > 0),
  api_access_level TEXT NOT NULL CHECK (api_access_level IN ('NONE', 'BASIC', 'FULL')),
  webhooks_enabled BOOLEAN NOT NULL DEFAULT false,
  advanced_reports_enabled BOOLEAN NOT NULL DEFAULT false,
  audit_enabled BOOLEAN NOT NULL DEFAULT false,
  support_level TEXT NOT NULL DEFAULT 'STANDARD' CHECK (support_level IN ('STANDARD', 'PRIORITY')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'TRIALING' CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELED')),
  billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY', 'YEARLY', 'MANUAL')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  provider TEXT NOT NULL DEFAULT 'MANUAL',
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  custom_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE subscription_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL,
  code TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING', 'ACTIVE', 'CANCELED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE whatsapp_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone_number TEXT,
  client_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'INITIALIZING', 'QR_PENDING', 'AUTHENTICATING', 'READY', 'DISCONNECTED', 'RECONNECTING', 'PAUSED', 'ERROR', 'DESTROYED')),
  connection_state TEXT,
  auth_strategy TEXT NOT NULL DEFAULT 'LOCAL',
  worker_id TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  daily_limit_override INTEGER CHECK (daily_limit_override IS NULL OR daily_limit_override > 0),
  sending_enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE sending_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  instance_id UUID NOT NULL,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME,
  end_time TIME,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES whatsapp_instances(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (instance_id, day_of_week)
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id UUID,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  email CITEXT,
  consent_status TEXT NOT NULL CHECK (consent_status IN ('UNKNOWN', 'GRANTED', 'REVOKED', 'BLOCKED')),
  consent_source TEXT NOT NULL,
  consent_at TIMESTAMPTZ,
  consent_evidence TEXT,
  opted_out_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  notes TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, instance_id) REFERENCES whatsapp_instances(tenant_id, id),
  UNIQUE (tenant_id, phone_number),
  UNIQUE (tenant_id, id)
);

CREATE TABLE consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL CHECK (new_status IN ('UNKNOWN', 'GRANTED', 'REVOKED', 'BLOCKED')),
  source TEXT NOT NULL,
  evidence TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE contact_complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  campaign_id UUID,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEWED', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE contact_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE contact_list_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  list_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, list_id) REFERENCES contact_lists(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (list_id, contact_id)
);

CREATE TABLE media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size >= 0),
  storage_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, storage_key)
);

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id UUID NOT NULL,
  name TEXT NOT NULL,
  message_template TEXT NOT NULL,
  media_id UUID,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELED', 'ERROR')),
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  consent_confirmed_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES whatsapp_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, media_id) REFERENCES media_files(tenant_id, id),
  UNIQUE (tenant_id, id)
);

ALTER TABLE contact_complaints
  ADD CONSTRAINT contact_complaints_campaign_fkey
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id);

CREATE TABLE campaign_lists (
  tenant_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  list_id UUID NOT NULL,
  PRIMARY KEY (campaign_id, list_id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, list_id) REFERENCES contact_lists(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  phone_number_snapshot TEXT NOT NULL,
  rendered_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELED', 'DEFERRED')),
  scheduled_for TIMESTAMPTZ,
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  external_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (campaign_id, contact_id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id UUID NOT NULL,
  campaign_id UUID,
  contact_id UUID,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  type TEXT NOT NULL CHECK (type IN ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LOCATION', 'CONTACT', 'UNKNOWN')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'RECEIVED', 'FAILED', 'SKIPPED')),
  external_message_id TEXT,
  content_ciphertext BYTEA,
  content_iv BYTEA,
  content_tag BYTEA,
  media_id UUID,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES whatsapp_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, media_id) REFERENCES media_files(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (instance_id, external_message_id)
);

CREATE TABLE daily_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  instance_id UUID NOT NULL,
  date DATE NOT NULL,
  timezone TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed > 0),
  queued INTEGER NOT NULL DEFAULT 0 CHECK (queued >= 0),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES whatsapp_instances(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (instance_id, date)
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_tag BYTEA NOT NULL,
  subscribed_events TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  webhook_endpoint_id UUID NOT NULL,
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'RETRYING', 'FAILED')),
  response_status INTEGER,
  response_body_summary TEXT,
  next_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, webhook_endpoint_id) REFERENCES webhook_endpoints(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (webhook_endpoint_id, event_id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE terms_versions (
  version TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE terms_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  terms_version TEXT NOT NULL REFERENCES terms_versions(version),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address INET,
  user_agent TEXT,
  UNIQUE (tenant_id, user_id, terms_version)
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES auth_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, key)
);

CREATE INDEX idx_memberships_user ON memberships (user_id, status);
CREATE INDEX idx_instances_tenant_status ON whatsapp_instances (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_instances_heartbeat ON whatsapp_instances (status, last_heartbeat_at) WHERE status IN ('INITIALIZING', 'AUTHENTICATING', 'READY', 'RECONNECTING');
CREATE INDEX idx_contacts_tenant_status ON contacts (tenant_id, consent_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_search ON contacts (tenant_id, lower(name));
CREATE INDEX idx_lists_tenant_status ON contact_lists (tenant_id, status);
CREATE INDEX idx_campaigns_tenant_status ON campaigns (tenant_id, status, scheduled_at);
CREATE INDEX idx_campaign_recipients_queue ON campaign_recipients (campaign_id, status, scheduled_for) WHERE status IN ('PENDING', 'QUEUED', 'DEFERRED');
CREATE INDEX idx_messages_tenant_created ON messages (tenant_id, created_at DESC);
CREATE INDEX idx_messages_instance_status ON messages (instance_id, status, created_at);
CREATE INDEX idx_daily_usage_tenant_date ON daily_usage (tenant_id, date DESC);
CREATE INDEX idx_api_keys_tenant_active ON api_keys (tenant_id, key_prefix) WHERE revoked_at IS NULL;
CREATE INDEX idx_webhook_delivery_queue ON webhook_deliveries (status, next_attempt_at) WHERE status IN ('PENDING', 'RETRYING');
CREATE INDEX idx_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_auth_sessions_active ON auth_sessions (user_id, tenant_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_idempotency_expiry ON idempotency_records (expires_at);

INSERT INTO terms_versions (version, title, content)
VALUES (
  '2026-07-16',
  'Termos e riscos da integracao nao oficial',
  'Esta plataforma utiliza integracao nao oficial com o WhatsApp Web. Sessoes podem ser desconectadas, alteracoes no WhatsApp Web podem interromper o servico e nao existe garantia contra restricoes ou bloqueios. O uso deve se limitar a comunicacoes autorizadas.'
);
