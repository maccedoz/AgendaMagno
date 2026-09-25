import { loadFinance, saveFinance } from './finance/store';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { schema, featureMigration } from './schema';
import { DomainError, emptyState, type State } from './domain';

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function createDatabase(
  url?: string,
  path?: string,
  initialize = true,
): Promise<Database> {
  if (url) {
    const pool = new Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
    });
    if (initialize) await pool.query(schema + featureMigration);
    return {
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await pool.query(sql, params)).rows as T[],
      }),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({
            query: async <T>(sql: string, params?: unknown[]) => ({
              rows: (await client.query(sql, params)).rows as T[],
            }),
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (path) await mkdir(path, { recursive: true });
  const pg = new PGlite(path);
  await pg.exec(schema + featureMigration);
  return {
    query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params),
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) }),
      ),
    close: () => pg.close(),
  };
}
const globalDb = globalThis as unknown as {
  agendaDb?: Promise<Database>;
  agendaFeatureMigrations?: Map<string, Promise<unknown>>;
};
export function db(): Promise<Database> {
  if (!globalDb.agendaDb) {
    // Erro comum, não falha interna: estas duas mensagens explicam o que configurar, e como
    // DomainError elas chegam à tela em vez de virarem um "verifique a configuração" genérico.
    if (process.env.VERCEL === '1' && process.env.DATABASE_MODE === 'local')
      throw new DomainError(
        'O banco embutido não funciona no app publicado: o disco da função é descartado a cada execução. Nas variáveis do projeto, configure DATABASE_MODE=postgres e DATABASE_URL com a conexão do Neon, e publique de novo.',
        503,
      );
    if (process.env.DATABASE_MODE !== 'local' && !process.env.DATABASE_URL)
      throw new DomainError(
        'Falta a conexão com o banco. Configure DATABASE_URL com a URL do Neon, que já inclui usuário e senha, ou DATABASE_MODE=local para usar o banco embutido em desenvolvimento.',
        503,
      );
    globalDb.agendaDb = createDatabase(
      process.env.DATABASE_MODE === 'local' ? undefined : process.env.DATABASE_URL,
      process.env.LOCAL_DATABASE_PATH ?? '.data/agenda',
      process.env.DATABASE_MODE === 'local' || process.env.DATABASE_AUTO_MIGRATE === 'true',
    );
    globalDb.agendaDb.catch(() => {
      delete globalDb.agendaDb;
    });
  }
  return globalDb.agendaDb.then(async (connection) => {
    // Only the local development database applies migrations on startup.
    // Production uses the migration connection, separate from the runtime role.
    if (process.env.DATABASE_MODE === 'local') {
      // A chave é o SQL da migração: uma atualização do código em desenvolvimento
      // aplica os novos acréscimos mesmo se a conexão sobreviver ao hot reload.
      globalDb.agendaFeatureMigrations ??= new Map();
      let migration = globalDb.agendaFeatureMigrations.get(featureMigration);
      if (!migration) {
        migration = connection.transaction(async (tx) => {
          await lock(tx);
          for (const statement of featureMigration.split(';').filter((s) => s.trim()))
            await tx.query(statement);
        });
        globalDb.agendaFeatureMigrations.set(featureMigration, migration);
        migration.catch(() => globalDb.agendaFeatureMigrations?.delete(featureMigration));
      }
      await migration;
    }
    return connection;
  });
}
// Falhas de banco chegam à API como um erro genérico, e "verifique a configuração" não diz o
// que conferir. O código do PostgreSQL separa os dois enganos comuns de uma primeira
// publicação: migração não aplicada e credencial desatualizada. Só o código é usado; o texto
// do banco pode carregar nomes de objetos e não vai para a tela.
export function databaseHint(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === '42P01')
    return 'O banco respondeu, mas as tabelas da agenda ainda não existem. Rode npm run db:migrate com a conexão administrativa antes do primeiro acesso.';
  if (code === '28P01' || code === '28000')
    return 'O banco recusou as credenciais da conexão. Confira DATABASE_URL: depois de trocar a senha no provedor, atualize a variável e publique de novo.';
  if (code === '3D000') return 'O banco indicado em DATABASE_URL não existe.';
  if (code === '42501')
    return 'A conexão do app não tem permissão para esta operação. Confira as permissões do usuário restrito.';
  return 'Verifique a configuração e a conexão com o banco.';
}
export async function lock(tx: Sql) {
  await tx.query('SELECT id FROM agenda_meta WHERE id=1 FOR UPDATE');
}
const tables = {
  groups: 'agenda_groups',
  tasks: 'agenda_tasks',
  history: 'agenda_history',
  operations: 'agenda_operations',
  conversations: 'agenda_conversations',
} as const;
export async function loadState(tx: Sql, includeFinance = false): Promise<State> {
  const state = emptyState();
  state.settings = (
    await tx.query<{ data: State['settings'] }>('SELECT data FROM agenda_meta WHERE id=1')
  ).rows[0].data;
  for (const [key, table] of Object.entries(tables) as [keyof typeof tables, string][]) {
    const rows = await tx.query<{ data: unknown }>(`SELECT data FROM ${table} ORDER BY id`);
    Object.assign(state, { [key]: rows.rows.map((r) => r.data) });
  }
  state.operations.sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.at.localeCompare(b.at),
  );
  state.history.sort((a, b) => a.at.localeCompare(b.at));
  if (includeFinance) state.finance = await loadFinance(tx);
  return state;
}
export async function saveState(tx: Sql, before: State, after: State) {
  if (after.finance)
    await saveFinance(tx, before.finance ?? (await loadFinance(tx)), after.finance);
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings))
    await tx.query('UPDATE agenda_meta SET data=$1::jsonb WHERE id=1', [
      JSON.stringify(after.settings),
    ]);
  for (const [key, table] of Object.entries(tables) as [keyof typeof tables, string][]) {
    const old = new Map(before[key].map((item) => [String(item.id), JSON.stringify(item)]));
    // Remove changed group rows first so restoring a backup can swap unique names atomically.
    if (key === 'groups')
      for (const item of before.groups) {
        const next = after.groups.find((g) => g.id === item.id);
        if (!next || JSON.stringify(next) !== JSON.stringify(item))
          await tx.query('DELETE FROM agenda_groups WHERE id=$1', [item.id]);
      }
    for (const item of after[key]) {
      const id = String(item.id);
      const json = JSON.stringify(item);
      if (old.get(id) !== json)
        await tx.query(
          `INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
          [id, json],
        );
      old.delete(id);
    }
    for (const id of old.keys()) await tx.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
  }
}
export async function consumeLimit(
  tx: Sql,
  key: string,
  maximum: number,
  windowMs: number,
  now = new Date(),
) {
  const result = await tx.query<{ count: number }>(
    `INSERT INTO agenda_limits (key,count,expires_at) VALUES ($1,1,$2)
    ON CONFLICT (key) DO UPDATE SET count=CASE WHEN agenda_limits.expires_at <= $3 THEN 1 ELSE agenda_limits.count+1 END,
    expires_at=CASE WHEN agenda_limits.expires_at <= $3 THEN $2 ELSE agenda_limits.expires_at END RETURNING count`,
    [key, new Date(now.getTime() + windowMs).toISOString(), now.toISOString()],
  );
  return result.rows[0].count <= maximum;
}
