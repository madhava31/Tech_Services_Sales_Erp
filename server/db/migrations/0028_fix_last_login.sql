-- Corrects "last signed in". Migration 0026 worked it out from session rows, but a salesperson's session ends at
-- 11:50 pm and is deleted, so people who signed in yesterday showed as quiet (or never signed in). Every
-- successful sign-in is kept in login_attempt, which is the reliable record.

UPDATE app_user u SET last_login_at = s.last
  FROM (SELECT username, MAX(at) AS last FROM login_attempt WHERE succeeded GROUP BY username) s
 WHERE s.username = lower(btrim(u.username))
   AND (u.last_login_at IS NULL OR s.last > u.last_login_at);

-- Anyone who has signed in within the last 72 hours is not in a quiet spell, so a reminder flag set on the wrong figure
-- is cleared (a later real quiet spell is then reminded as usual).
UPDATE app_user SET inactive_alerted_at = NULL
 WHERE inactive_alerted_at IS NOT NULL AND last_login_at IS NOT NULL AND last_login_at > NOW() - INTERVAL '72 hours';

-- A "you haven't signed in for N days" reminder sent on the wrong figure is taken back from the bell of anyone who
-- had in fact signed in within the last 72 hours.
DELETE FROM notification n USING app_user u
 WHERE n.user_id = u.id AND n.kind = 'inactive_reminder'
   AND u.last_login_at IS NOT NULL AND u.last_login_at > NOW() - INTERVAL '72 hours';
