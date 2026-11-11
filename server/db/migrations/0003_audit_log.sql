-- Append-only audit trail for account changes, ownership transfers and other sensitive actions.
-- The API connects as a single database role, so revoking privileges can't stop the app itself
-- from rewriting history; triggers make UPDATE, DELETE and TRUNCATE fail for everyone instead.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id INTEGER REFERENCES app_user(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT,
  before JSONB,
  after JSONB
);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, at);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_user_id, at);

CREATE FUNCTION audit_log_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
