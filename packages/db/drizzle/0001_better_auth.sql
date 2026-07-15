ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_email_verified boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth_accounts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  id_token text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_accounts_provider_account_uq
  ON auth_accounts (provider_id, account_id);
CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx
  ON auth_accounts (user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_uq
  ON auth_sessions (token);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
  ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS auth_verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_verifications_identifier_value_uq
  ON auth_verifications (identifier, value);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id text PRIMARY KEY,
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_rate_limits_key_uq
  ON auth_rate_limits (key);

CREATE TABLE IF NOT EXISTS password_login_guards (
  email text PRIMARY KEY CHECK (email = lower(trim(email))),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE auth_accounts, auth_sessions, auth_verifications,
    auth_rate_limits, password_login_guards
  TO wukong_app;
