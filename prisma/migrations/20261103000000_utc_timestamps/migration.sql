-- @prisma/adapter-pg wrote timestamptz values as UTC wall-clock text without an offset, so
-- PostgreSQL read them in the session time zone (the database default) and stored every
-- instant shifted by that zone's offset. The app now opens UTC sessions
-- (src/database/pg-adapter.ts). migrate deploy runs in the same default zone the app used,
-- so "(value AT TIME ZONE zone) AT TIME ZONE 'UTC'" recovers exactly the instant that was
-- meant (DST-aware), and on a database whose default zone is UTC nothing changes.
-- Apply it only through `prisma migrate deploy`, with the backend stopped: migrate records
-- it as applied, while running this file by hand as well would shift every value twice.
-- The app refuses to start until it is recorded (assertUtcDatabase). To go back to code
-- without the UTC session, apply the inverse first:
--   UPDATE t SET col = (col AT TIME ZONE 'UTC') AT TIME ZONE '<database zone>';
DO $$
DECLARE
  zone text := current_setting('TimeZone');
  target record;
BEGIN
  IF zone IN ('UTC', 'Etc/UTC', 'UCT', 'Etc/UCT', 'Universal', 'Etc/Universal',
              'Zulu', 'Etc/Zulu', 'GMT', 'Etc/GMT', 'GMT0', 'Etc/GMT0', 'GMT+0',
              'GMT-0', 'Greenwich', 'Etc/Greenwich') THEN
    RETURN;
  END IF;
  -- One UPDATE per table, so CHECK constraints between a row's timestamps stay valid. Only
  -- this project's tables: any other table in the schema keeps its values.
  FOR target IN
    SELECT c.table_name,
           string_agg(format('%1$I = (%1$I AT TIME ZONE %2$L) AT TIME ZONE ''UTC''',
                             c.column_name, zone), ', ') AS assignments
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema()
      AND t.table_type = 'BASE TABLE'
      AND c.data_type = 'timestamp with time zone'
      AND c.table_name IN ('conversations', 'message_attachments',
                           'message_status_events', 'messages', 'messaging_outbox',
                           'messaging_webhook_rejections', 'reservation_notes',
                           'reservation_requests', 'reservation_reschedule_history',
                           'reservations', 'samanta_drafts')
    GROUP BY c.table_name
  LOOP
    EXECUTE format('UPDATE %I SET %s', target.table_name, target.assignments);
  END LOOP;
END $$;
