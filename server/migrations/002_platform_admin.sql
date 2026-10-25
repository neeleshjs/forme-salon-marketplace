CREATE TABLE IF NOT EXISTS platform_admin_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'reviewer', 'support')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT NOT NULL,
  last_totp_counter BIGINT NOT NULL DEFAULT -1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES platform_admin_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS platform_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  admin_id UUID NOT NULL REFERENCES platform_admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS platform_admin_sessions_admin_idx ON platform_admin_sessions (admin_id, expires_at);

CREATE TABLE IF NOT EXISTS platform_admin_invites (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'reviewer', 'support')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES platform_admin_users(id),
  totp_secret_encrypted TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS platform_admin_invites_email_idx ON platform_admin_invites (email, expires_at);

CREATE TABLE IF NOT EXISTS platform_admin_bootstrap_challenges (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  totp_secret_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_admin_login_attempts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS platform_admin_login_attempts_email_time_idx ON platform_admin_login_attempts (email, attempted_at);

CREATE TABLE IF NOT EXISTS platform_admin_audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES platform_admin_users(id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  remote_address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS platform_admin_audit_events_created_idx ON platform_admin_audit_events (created_at DESC, id DESC);
