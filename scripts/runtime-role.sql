-- Execute with the migration/admin connection after npm run db:migrate.
-- This permission group has no password and cannot log in on its own.
CREATE ROLE agenda_runtime NOLOGIN;
GRANT USAGE ON SCHEMA public TO agenda_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  agenda_meta, agenda_groups, agenda_tasks, agenda_history, agenda_operations,
  agenda_conversations, agenda_messages, agenda_limits, agenda_llm_providers,
  agenda_llm_usage, agenda_security, agenda_sessions,
  agenda_push_subscriptions, agenda_push_sent,
  agenda_finance_entries, agenda_finance_categories, agenda_finance_templates,
  agenda_finance_plan,
  agenda_notes, agenda_note_files
TO agenda_runtime;
-- Grant this role to a dedicated login created in Neon, then use that login in
-- DATABASE_URL. It must NOT own the database/tables or inherit an admin role.
-- GRANT agenda_runtime TO your_dedicated_login;
-- Do not use the migration/admin connection in the running app.
