import { pathToFileURL } from 'node:url';
import { createDatabase, databaseHint } from '../src/backend/db';
import { schema, featureMigration } from '../src/backend/schema';

// Qual banco esta execução vai migrar. DATABASE_MIGRATION_URL é uma declaração de intenção:
// quem a define está dizendo qual banco quer preparar. Sem esta precedência, um .env de
// desenvolvimento com DATABASE_MODE=local fazia a migração recair no banco embutido e anunciar
// sucesso, sem ter tocado no banco publicado — e o erro só aparecia no primeiro acesso.
export function migrationTarget(env: Record<string, string | undefined> = process.env) {
  const url =
    env.DATABASE_MIGRATION_URL?.trim() ||
    (env.DATABASE_MODE === 'local' ? '' : env.DATABASE_URL?.trim());
  if (!url) {
    if (env.DATABASE_MODE !== 'local')
      throw new Error(
        'Falta a conexão de migração. Informe DATABASE_MIGRATION_URL com a credencial administrativa do banco, ou DATABASE_MODE=local para preparar o banco embutido.',
      );
    return { url: undefined, label: `banco local em ${env.LOCAL_DATABASE_PATH ?? '.data/agenda'}` };
  }
  // Só host e nome do banco: a URL carrega usuário e senha, que não vão para a saída.
  const parsed = new URL(url);
  return { url, label: `${parsed.host}${parsed.pathname}` };
}
// A mesma fonte atende a CLI e o editor SQL do provedor; inclui todas as adições.
export const runtimeGrants = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenda_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${[...(schema + featureMigration).matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).join(', ')} TO agenda_runtime;
  END IF;
END $$;`;
export function migrationSql() {
  return `-- Gerado por npm run db:sql. Migração idempotente; use a conexão administrativa.\nBEGIN;\n${schema}\n${featureMigration}\n${runtimeGrants}\nCOMMIT;\n`;
}
export async function main() {
  if (process.argv.includes('--sql')) {
    process.stdout.write(migrationSql());
    return;
  }
  const target = migrationTarget();
  const database = await createDatabase(
    target.url,
    process.env.LOCAL_DATABASE_PATH ?? '.data/agenda',
  );
  try {
    await database.query(runtimeGrants);
    // Dizer onde foi aplicada evita a dúvida que motivou a precedência acima.
    console.log(`Schema do AgendaMagna aplicado em ${target.label}. Migração idempotente.`);
  } finally {
    await database.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`Falha ao preparar o banco. ${databaseHint(error)}`);
    if (error instanceof Error && !(error as { code?: string }).code) console.error(error.message);
    process.exitCode = 1;
  });
