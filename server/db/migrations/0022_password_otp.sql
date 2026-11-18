-- One-time codes sent to a salesperson's registered mobile, to verify them when they set their own password
-- (the first sign-in after an admin created or reset the account, and "forgot password"). Additive only.

-- True after an admin creates or resets a salesperson's login: the temporary password must be replaced
-- before anything else in the app opens. Existing accounts are not affected.
ALTER TABLE app_user ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE otp_challenge (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('first_login', 'forgot')),
  phone TEXT NOT NULL,
  -- The code itself is never stored, only a salted hash of it.
  salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_otp_challenge_user ON otp_challenge(user_id, created_at DESC);
CREATE INDEX idx_otp_challenge_ip ON otp_challenge(ip, created_at DESC);
