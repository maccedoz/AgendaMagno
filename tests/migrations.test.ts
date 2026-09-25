import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase, db, type Database } from '../src/backend/db';
import { migrationSql } from '../scripts/migrate';

test('SQL exportado cria todas as adições e pode ser repetido sem perder dados', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(migrationSql());
    await pg.query(
      'INSERT INTO agenda_notes(id,data) VALUES (\'nota-preservada\',\'{"title":"Preservar"}\')',
    );
    await pg.exec(migrationSql());
    const { rows } = await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    for (const table of [
      'agenda_finance_categories',
      'agenda_finance_entries',
      'agenda_finance_templates',
      'agenda_notes',
      'agenda_note_files',
    ])
      assert.ok(
        rows.some((r) => r.table_name === table),
        table,
      );
    assert.equal((await pg.query('SELECT * FROM agenda_notes')).rows.length, 1);
    assert.equal((await pg.query('SELECT * FROM agenda_finance_categories')).rows.length, 10);
  } finally {
    await pg.close();
  }
});

test('conexão local sobrevivente à atualização recebe tabelas novas', async () => {
  const database = await createDatabase();
  const state = globalThis as unknown as {
    agendaDb?: Promise<Database>;
    agendaFeatureMigrations?: Map<string, Promise<unknown>>;
    agendaFeaturesV2?: Promise<unknown>;
  };
  const previous = {
    db: state.agendaDb,
    migrations: state.agendaFeatureMigrations,
    legacy: state.agendaFeaturesV2,
    mode: process.env.DATABASE_MODE,
  };
  try {
    await database.query('DROP TABLE agenda_note_files');
    await database.query('DROP TABLE agenda_finance_templates');
    state.agendaDb = Promise.resolve(database);
    state.agendaFeaturesV2 = Promise.resolve();
    state.agendaFeatureMigrations = new Map([['SQL anterior', Promise.resolve()]]);
    process.env.DATABASE_MODE = 'local';
    const ready = await db();
    assert.deepEqual((await ready.query('SELECT * FROM agenda_note_files')).rows, []);
    assert.deepEqual((await ready.query('SELECT * FROM agenda_finance_templates')).rows, []);
    await db();
    assert.equal((await ready.query('SELECT * FROM agenda_finance_categories')).rows.length, 10);
  } finally {
    state.agendaDb = previous.db;
    state.agendaFeatureMigrations = previous.migrations;
    state.agendaFeaturesV2 = previous.legacy;
    if (previous.mode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous.mode;
    await database.close();
  }
});
