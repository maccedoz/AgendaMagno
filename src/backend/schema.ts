export const usageDetailsMigration = `ALTER TABLE agenda_llm_usage
  ADD COLUMN IF NOT EXISTS reported_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unconfirmed_requests integer NOT NULL DEFAULT 0`;

export const schema = `
CREATE TABLE IF NOT EXISTS agenda_meta (
  id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL
);
INSERT INTO agenda_meta (id, data) VALUES (1, '{"retentionDays":30,"nextTaskId":1,"revision":0}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS agenda_groups (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS agenda_group_name ON agenda_groups (lower(data->>'name'));
CREATE TABLE IF NOT EXISTS agenda_tasks (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_task_purge ON agenda_tasks ((data->>'purgeAt'));
CREATE TABLE IF NOT EXISTS agenda_history (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_history_task ON agenda_history ((data->>'taskId'));
CREATE TABLE IF NOT EXISTS agenda_operations (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_conversations (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_messages (
  id text PRIMARY KEY, external_id text NOT NULL UNIQUE, channel text NOT NULL,
  body text, reply text, status text NOT NULL DEFAULT 'pending',
  lease_token text, lease_until timestamptz, error text,
  created_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_messages_channel ON agenda_messages (channel, status);
CREATE TABLE IF NOT EXISTS agenda_limits (key text PRIMARY KEY, count integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_llm_providers (
  id text PRIMARY KEY, config jsonb NOT NULL, encrypted_key text NOT NULL,
  cooldown_until timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agenda_llm_usage (
  provider_id text NOT NULL REFERENCES agenda_llm_providers(id) ON DELETE CASCADE,
  day text NOT NULL, requests integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0, reserved_tokens bigint NOT NULL DEFAULT 0,
  reserved_until timestamptz,
  PRIMARY KEY (provider_id, day)
);
${usageDetailsMigration};
`;

export const featureMigration = `
CREATE TABLE IF NOT EXISTS agenda_security (id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL DEFAULT '{}');
INSERT INTO agenda_security(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS agenda_sessions (
  id text PRIMARY KEY, token_hash text UNIQUE NOT NULL, label text NOT NULL,
  trusted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_sessions_expiry ON agenda_sessions(expires_at);
CREATE TABLE IF NOT EXISTS agenda_push_subscriptions (
  id text PRIMARY KEY, endpoint text NOT NULL UNIQUE, p256dh text NOT NULL, auth text NOT NULL,
  label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz, last_failure_at timestamptz, last_error text
);
CREATE TABLE IF NOT EXISTS agenda_push_sent (
  task_id bigint NOT NULL, reminder_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, reminder_at)
);
UPDATE agenda_tasks SET data=data || '{"trashedAt":null,"purgeAt":null,"trashReason":null}'::jsonb
 WHERE data->>'status'='completed' AND data->>'trashReason'='completed';

CREATE TABLE IF NOT EXISTS agenda_finance_categories (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_finance_entries (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_finance_templates (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_finance_plan (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_notes (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_note_files (
  id text PRIMARY KEY,
  note_id text NOT NULL,
  data jsonb NOT NULL,
  content text NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_note_files_note ON agenda_note_files(note_id);
CREATE INDEX IF NOT EXISTS agenda_notes_updated ON agenda_notes ((data->>'updatedAt'));
CREATE INDEX IF NOT EXISTS agenda_finance_period ON agenda_finance_entries ((data->>'date'));
CREATE INDEX IF NOT EXISTS agenda_finance_category ON agenda_finance_entries ((data->>'categoryId'));
CREATE INDEX IF NOT EXISTS agenda_finance_active ON agenda_finance_entries ((data->>'date')) WHERE data->>'deletedAt' IS NULL;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000001', '{"id": "00000000-0000-4000-8000-000000000001", "name": "Salário", "kind": "income", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000002', '{"id": "00000000-0000-4000-8000-000000000002", "name": "Outras receitas", "kind": "income", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000003', '{"id": "00000000-0000-4000-8000-000000000003", "name": "Alimentação", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000004', '{"id": "00000000-0000-4000-8000-000000000004", "name": "Transporte", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000005', '{"id": "00000000-0000-4000-8000-000000000005", "name": "Moradia", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000006', '{"id": "00000000-0000-4000-8000-000000000006", "name": "Saúde", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000007', '{"id": "00000000-0000-4000-8000-000000000007", "name": "Estudos", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000008', '{"id": "00000000-0000-4000-8000-000000000008", "name": "Lazer", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000009', '{"id": "00000000-0000-4000-8000-000000000009", "name": "Compras", "kind": "expense", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
INSERT INTO agenda_finance_categories(id,data) SELECT '00000000-0000-4000-8000-000000000010', '{"id": "00000000-0000-4000-8000-000000000010", "name": "Sem categoria", "kind": "both", "archivedAt": null, "version": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE NOT EXISTS (SELECT 1 FROM agenda_meta WHERE data->>'financeInitialized'='true') ON CONFLICT DO NOTHING;
UPDATE agenda_meta SET data=data || '{"financeInitialized":true}'::jsonb WHERE id=1 AND data->>'financeInitialized' IS DISTINCT FROM 'true';
`;
