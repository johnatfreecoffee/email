-- Move a.* / e.* agent mail into folder=agent so it never appears in
-- inbox, catch-all, or All Mail. Always-read; worker still processes rows.

UPDATE email_messages m
SET
  folder = 'agent',
  is_read = true,
  is_catch_all = false
FROM email_addresses a
WHERE m.address_id = a.id
  AND a.address ~* '^[ae]\.'
  AND (m.folder IS DISTINCT FROM 'agent' OR m.is_read = false OR m.is_catch_all = true);
