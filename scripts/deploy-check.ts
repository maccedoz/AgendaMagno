// Confere a configuração de produção antes de publicar. Não altera nada e não faz deploy:
// só lê o ambiente e o banco e diz o que impede o app de funcionar. O que quebra o app sai
// como ERRO e derruba o código de saída; o que é endurecimento sai como AVISO.
//
// Uso, com as variáveis do ambiente publicado:
//   DATABASE_MODE=postgres DATABASE_URL='postgresql://…' APP_URL='https://…' \
//   PANEL_PASSWORD_HASH=… LLM_ENCRYPTION_KEY=… CRON_SECRET=… npm run deploy:check
import { createDatabase, type Database } from '../src/backend/db';
import { decryptKey } from '../src/backend/llm/crypto';
import { schema, featureMigration } from '../src/backend/schema';

const problems: string[] = [];
const warnings: string[] = [];
const fail = (text: string) => problems.push(text);
const warn = (text: string) => warnings.push(text);
const env = (name: string) => process.env[name]?.trim() ?? '';

function checkEnvironment() {
  if (env('DATABASE_MODE') !== 'postgres')
    fail(
      'DATABASE_MODE precisa ser "postgres" no app publicado. O banco embutido vive no disco da função, que é descartado a cada execução.',
    );
  const url = env('DATABASE_URL');
  if (!url) fail('DATABASE_URL está vazia. Use a conexão do Neon.');
  else {
    if (!/^postgres(ql)?:\/\//.test(url)) fail('DATABASE_URL não parece uma conexão PostgreSQL.');
    if (!/sslmode=require/.test(url))
      warn('DATABASE_URL sem sslmode=require. O Neon aceita, mas deixe o SSL explícito.');
    if (!/-pooler\./.test(url))
      warn(
        'DATABASE_URL não usa o host agrupado (-pooler). Funções sem pooling esgotam as conexões do Neon sob uso normal.',
      );
  }
  const app = env('APP_URL');
  if (!app) fail('APP_URL está vazia. Ela define a única origem aceita pelo app.');
  else {
    try {
      const parsed = new URL(app);
      if (parsed.protocol !== 'https:')
        fail('APP_URL precisa ser https no ambiente publicado; o cookie de sessão exige Secure.');
      if (parsed.pathname !== '/' || app.endsWith('/'))
        fail(`APP_URL deve ser só a origem, sem caminho nem barra final. Use ${parsed.origin}.`);
    } catch {
      fail('APP_URL não é uma URL válida.');
    }
  }
  const hash = env('PANEL_PASSWORD_HASH');
  if (hash) {
    const [salt, expected] = hash.split(':');
    if (!salt || !/^[a-f\d]{128}$/i.test(expected ?? ''))
      fail('PANEL_PASSWORD_HASH fora do formato "salt:hash". Gere com npm run senha:hash.');
    if (env('PANEL_PASSWORD'))
      warn(
        'PANEL_PASSWORD e PANEL_PASSWORD_HASH estão definidas. O hash vence; remova a senha em texto do ambiente.',
      );
  } else if (!env('PANEL_PASSWORD')) {
    fail('Sem PANEL_PASSWORD nem PANEL_PASSWORD_HASH: ninguém consegue entrar.');
  } else {
    warn(
      'A senha está em texto puro em PANEL_PASSWORD. Prefira PANEL_PASSWORD_HASH (npm run senha:hash), para que o painel da Vercel não guarde a senha legível.',
    );
  }
  const key = env('LLM_ENCRYPTION_KEY');
  if (!/^[a-f\d]{64}$/i.test(key) && !/^[A-Za-z0-9+/]{43}=$/.test(key))
    fail('LLM_ENCRYPTION_KEY precisa ter 32 bytes em hexadecimal (64 caracteres) ou base64.');
  const cron = env('CRON_SECRET');
  if (!cron) warn('Sem CRON_SECRET, a limpeza diária da lixeira não roda. O resto funciona.');
  else if (cron.length < 32) fail('CRON_SECRET precisa de pelo menos 32 caracteres.');
  const vapidKeys = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].filter(env);
  if (!vapidKeys.length)
    warn(
      'Sem chaves VAPID, os lembretes com o app fechado ficam desligados. Gere com npm run push:keys.',
    );
  else if (vapidKeys.length < 3)
    fail('Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT juntas, ou nenhuma delas.');
  else if (!/^(mailto:|https:\/\/)/.test(env('VAPID_SUBJECT')))
    fail('VAPID_SUBJECT precisa começar com mailto: (ou https://).');
  if (env('DATABASE_AUTO_MIGRATE') === 'true')
    fail(
      'DATABASE_AUTO_MIGRATE=true no app publicado. As migrações usam a conexão administrativa, separada; deixe esta variável em false.',
    );
  if (env('DATABASE_MIGRATION_URL'))
    warn(
      'DATABASE_MIGRATION_URL está no ambiente. A credencial administrativa deve ficar fora do app publicado — mantenha-a só na máquina ou CI que migra.',
    );
}

const tableNames = [...(schema + featureMigration).matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
  .map((match) => match[1])
  .sort();

async function checkDatabase(database: Database) {
  const present = new Set(
    (
      await database.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows.map((row) => row.table_name),
  );
  const missing = tableNames.filter((name) => !present.has(name));
  if (missing.length)
    fail(
      `Faltam tabelas no banco: ${missing.join(', ')}. Rode npm run db:migrate com a conexão administrativa antes de publicar.`,
    );
  else console.log(`  banco: as ${tableNames.length} tabelas do schema estão aplicadas.`);
  if (missing.length) return;

  // A chave do servidor é o que abre as chaves de IA guardadas. Trocá-la não dá erro de
  // partida: o app sobe e só falha na primeira mensagem, já em produção.
  const providers = await database.query<{ id: string; encrypted_key: string; name: string }>(
    "SELECT id,encrypted_key,config->>'name' AS name FROM agenda_llm_providers",
  );
  for (const provider of providers.rows) {
    try {
      decryptKey(provider.encrypted_key, provider.id);
    } catch {
      fail(
        `A chave da IA “${provider.name}” não abre com esta LLM_ENCRYPTION_KEY. Use a chave original ou cadastre a API de novo depois de publicar.`,
      );
    }
  }
  if (providers.rows.length)
    console.log(`  IA: ${providers.rows.length} provedor(es) cadastrado(s), chaves conferidas.`);
  else warn('Nenhuma IA cadastrada neste banco. O app entende só frases em formato exato.');

  for (const table of tableNames) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const result = await database.query<{ allowed: boolean }>(
        'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [table, privilege],
      );
      if (!result.rows[0]?.allowed)
        fail(`Falta ${privilege} em ${table}. Atualize os GRANTs de scripts/runtime-role.sql.`);
    }
  }

  // O app publicado não deve poder mudar o schema. Isto é endurecimento, não requisito.
  const probe = `agenda_deploy_check_${Date.now()}`;
  try {
    await database.query(`CREATE TABLE ${probe} (id integer)`);
    await database.query(`DROP TABLE ${probe}`);
    warn(
      'Esta DATABASE_URL consegue criar e apagar tabelas. Publique com um usuário restrito — veja scripts/runtime-role.sql.',
    );
  } catch {
    console.log('  permissões: a conexão do app não cria nem apaga tabelas.');
  }
}

async function main() {
  console.log('Conferindo a configuração de produção…\n');
  checkEnvironment();
  if (env('DATABASE_MODE') === 'postgres' && env('DATABASE_URL')) {
    let database: Database | null = null;
    try {
      database = await createDatabase(env('DATABASE_URL'), undefined, false);
      await checkDatabase(database);
    } catch (error) {
      fail(`Não foi possível usar o banco: ${(error as Error).message}`);
    } finally {
      await database?.close().catch(() => {});
    }
  } else {
    warn('Banco não verificado: informe DATABASE_MODE=postgres e DATABASE_URL para conferi-lo.');
  }
  for (const text of warnings) console.log(`\nAVISO  ${text}`);
  for (const text of problems) console.log(`\nERRO   ${text}`);
  console.log(
    problems.length
      ? `\n${problems.length} problema(s) impedem o deploy.`
      : '\nConfiguração pronta para publicar.' +
          (warnings.length ? ` ${warnings.length} aviso(s) acima.` : ''),
  );
  process.exitCode = problems.length ? 1 : 0;
}
main().catch((error) => {
  console.error(`Falha na verificação: ${(error as Error).message}`);
  process.exitCode = 1;
});
