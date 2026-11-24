-- Salespeople sign in every day: their session ends at 11:50 pm India time, and a login that hasn't signed in
-- for 72 hours is reminded, and flagged to the admin. Additive only.
ALTER TABLE app_user ADD COLUMN last_login_at TIMESTAMPTZ;
-- When the reminder for the current quiet spell was sent; cleared when the person signs in again.
ALTER TABLE app_user ADD COLUMN inactive_alerted_at TIMESTAMPTZ;

UPDATE app_user u SET last_login_at = s.last
  FROM (SELECT user_id, MAX(created_at) AS last FROM session GROUP BY user_id) s
 WHERE s.user_id = u.id;

-- Sessions a salesperson already has end at the next 11:50 pm too, from now on.
UPDATE session SET expires_at = LEAST(
    expires_at,
    CASE WHEN ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '23 hours 50 minutes') AT TIME ZONE 'Asia/Kolkata') > NOW()
         THEN ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '23 hours 50 minutes') AT TIME ZONE 'Asia/Kolkata')
         ELSE ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day 23 hours 50 minutes') AT TIME ZONE 'Asia/Kolkata')
    END)
 WHERE user_id IN (SELECT id FROM app_user WHERE role = 'salesperson');
