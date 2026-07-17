CREATE TABLE platform_admins (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT[] NOT NULL DEFAULT ARRAY['platform.manage']::text[],
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
