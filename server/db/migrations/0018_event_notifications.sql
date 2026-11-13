-- Notifications for things that happen, not only the once-a-day digests: a company sent for approval,
-- and its approval or rejection. Those can come many times a day, so "one per person per kind per day"
-- now applies only to the digest and the weekly report.
ALTER TABLE notification DROP CONSTRAINT notification_user_id_kind_for_date_key;
CREATE UNIQUE INDEX notification_once_a_day ON notification (user_id, kind, for_date)
  WHERE kind IN ('daily_digest', 'weekly_report');

-- What a notification is about, so it can be marked handled when someone else acts on it.
ALTER TABLE notification ADD COLUMN ref_type TEXT;
ALTER TABLE notification ADD COLUMN ref_id INTEGER;
CREATE INDEX idx_notification_ref ON notification (ref_type, ref_id) WHERE ref_type IS NOT NULL;
