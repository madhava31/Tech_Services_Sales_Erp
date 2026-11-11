-- Accounts, sessions and sign-in throttling.
--
-- Roles (docs/architecture-plan.md §3):
--   admin, managing_director — manage users; see everything
--   sales_manager            — sees and reassigns all salespeople's records
--   salesperson              — sees own records only; must be linked to a salesperson row (0002)
--   office_staff             — prepares quotations requested from the field
--
-- Accounts are deactivated, never deleted: records stay attributed after someone leaves.
CREATE TABLE app_user (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CONSTRAINT app_user_role_check
    CHECK (role IN ('admin', 'managing_director', 'sales_manager', 'salesperson', 'office_staff')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deactivated_at TIMESTAMPTZ,
  deactivated_by INTEGER REFERENCES app_user(id),
  manager_user_id INTEGER REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_user_deactivation_consistent CHECK (is_active = (deactivated_at IS NULL)),
  CONSTRAINT app_user_not_own_manager CHECK (manager_user_id <> id)
);

CREATE TABLE session (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_session_user ON session(user_id);

-- Sign-in attempts, used to throttle password guessing (routes/auth.js). Kept in Postgres rather
-- than memory so the limit holds across serverless instances.
CREATE TABLE login_attempt (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  ip TEXT,
  succeeded BOOLEAN NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_login_attempt_username_at ON login_attempt(username, at);
CREATE INDEX idx_login_attempt_ip_at ON login_attempt(ip, at);
