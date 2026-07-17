CREATE TABLE subscription_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL,
  requested_plan_id UUID NOT NULL REFERENCES plans(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'APPLIED')),
  provider_reference TEXT,
  effective_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX subscription_change_requests_pending_uidx
  ON subscription_change_requests (tenant_id)
  WHERE status = 'PENDING';
