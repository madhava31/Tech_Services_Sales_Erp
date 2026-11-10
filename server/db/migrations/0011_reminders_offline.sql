-- In-app reminders, phone push subscriptions, and safe retries for changes made offline.

-- One digest per person per day: the unique key stops a restart or a second server sending it twice.
CREATE TABLE notification (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL,
  for_date DATE NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, for_date)
);
CREATE INDEX idx_notification_user ON notification(user_id, created_at DESC);

-- A device that agreed to receive push. Not a business record: removed when the browser says the
-- subscription has ended or the person signs out.
CREATE TABLE push_subscription (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_push_subscription_user ON push_subscription(user_id);

-- The answer to a change already applied, so a retry after a dropped connection returns it instead
-- of applying the change twice. Old rows are cleared by the daily job.
CREATE TABLE request_idempotency (
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  key UUID NOT NULL,
  status INTEGER NOT NULL,
  body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idx_request_idempotency_created ON request_idempotency(created_at);
