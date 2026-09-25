import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase, loadState, type Database } from '../src/backend/db';
import { login, session, revokeSession, updateAccess, accessInfo } from '../src/backend/access';
import { totp, verifyTotp } from '../src/backend/totp';
import { allowedOrigins, sameOrigin, verifyPassword } from '../src/backend/auth';
import { panelAction } from '../src/backend/service';
import { GET, POST } from '../src/app/api/[...path]/route';
let database: Database;
const password = 'isolated-test-password';
const globals = globalThis as unknown as {
  agendaDb?: Promise<Database>;
  agendaFeaturesV2?: Promise<unknown>;
};
before(async () => {
  process.env.DATABASE_MODE = 'local';
  process.env.PANEL_PASSWORD = password;
  delete process.env.PANEL_PASSWORD_HASH;
  process.env.LLM_ENCRYPTION_KEY = '12'.repeat(32);
  process.env.APP_URL = 'http://localhost:3100';
  delete process.env.VERCEL;
  database = await createDatabase();
  globals.agendaDb = Promise.resolve(database);
  globals.agendaFeaturesV2 = Promise.resolve();
});
beforeEach(async () => {
  await database.query('DELETE FROM agenda_limits');
  await database.query('DELETE FROM agenda_sessions');
  await database.query("UPDATE agenda_security SET data='{}'::jsonb WHERE id=1");
});
after(async () => {
  delete globals.agendaDb;
  delete globals.agendaFeaturesV2;
  await database.close();
});
function req(cookie = '') {
  return new Request('http://localhost:3100', { headers: { cookie } });
}
async function call(path: string, body?: unknown, cookie = '', origin = 'http://localhost:3100') {
  const request = new Request(`http://localhost:3100/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ path: path.split('/') }),
  });
}
async function signed(trusted = false) {
  const result = await login(req(), { password, trusted, device: 'Teste' }, database);
  return result.cookie!.split(';')[0];
}
test('TOTP follows RFC 6238 known vectors and refuses reuse', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret, 1, 8), '94287082');
  assert.equal(totp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(verifyTotp(secret, '287082', -1, 59000), 1);
  assert.equal(verifyTotp(secret, '287082', 1, 59000), null);
});
test('trusted sessions persist 90 days, ordinary sessions 12 hours; revocation is server-side', async () => {
  const cookie = await signed(true);
  const current = (await session(req(cookie), database))!;
  assert.ok(Date.parse(current.expires_at) - Date.now() > 89 * 86400000);
  assert.equal(current.trusted, true);
  assert.equal(await session(req(cookie + 'bad'), database), null);
  await revokeSession(current.id, database);
  assert.equal(await session(req(cookie), database), null);
  const ordinary = (await session(req(await signed()), database))!;
  assert.ok(Date.parse(ordinary.expires_at) - Date.now() <= 12 * 3600000);
  await database.query("UPDATE agenda_sessions SET expires_at=now()-interval '1 second'");
  assert.equal(await session(req(cookie), database), null);
});
test('2FA activation verifies code, revokes other sessions and recovery works once', async () => {
  const first = await signed(true);
  const current = (await session(req(first), database))!;
  const other = await signed();
  const setup = await updateAccess(current, { action: 'setup', password });
  assert.ok('secret' in setup);
  await assert.rejects(
    updateAccess(current, { action: 'enable', password, code: 'wrong' }),
    /Código inválido/,
  );
  const enabled = await updateAccess(current, {
    action: 'enable',
    password,
    code: totp(setup.secret!),
  });
  assert.ok('recoveryCodes' in enabled);
  assert.equal(await session(req(other), database), null);
  const challenge = await login(req(), { password }, database);
  assert.equal(challenge.needsCode, true);
  assert.equal(challenge.cookie, null);
  await assert.rejects(
    login(req(), { password, code: totp(setup.secret!) }, database),
    /já utilizado/,
  );
  const recovered = await login(req(), { password, code: enabled.recoveryCodes![0] }, database);
  assert.ok(recovered.cookie);
  await assert.rejects(
    login(req(), { password, code: enabled.recoveryCodes![0] }, database),
    /inválido/,
  );
  assert.equal((await accessInfo(current)).recoveryRemaining, 9);
  const stored = (
    await database.query<{ data: Record<string, unknown> }>('SELECT data FROM agenda_security')
  ).rows[0].data;
  assert.ok(!JSON.stringify(stored).includes(setup.secret!));
  assert.ok(!JSON.stringify(stored).includes(enabled.recoveryCodes![0]));
});
test('changing the password invalidates other devices and the bootstrap password', async () => {
  const first = await signed();
  const current = (await session(req(first), database))!;
  const other = await signed();
  const next = 'new-isolated-test-password';
  await updateAccess(current, { action: 'password', password, newPassword: next });
  assert.equal(await session(req(other), database), null);
  assert.ok(await session(req(first), database));
  await assert.rejects(login(req(), { password }, database), /incorreta/);
  assert.ok((await login(req(), { password: next }, database)).cookie);
});
test('SQL injection from login and malformed credentials never grants a session', async () => {
  for (const payload of ["' OR '1'='1", "'; DROP TABLE agenda_tasks;--", '\u0000admin']) {
    const result = await call('login', { password: payload });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('set-cookie'), null);
  }
  assert.equal((await call('login', { password: { $ne: null } })).status, 400);
  assert.equal((await call('state')).status, 401);
  assert.equal((await call('security')).status, 401);
  assert.equal((await call('backup')).status, 401);
  assert.equal(
    (
      await call('actions', {
        commands: [{ op: 'create_group', name: 'Exploit' }],
        requestId: randomUUID(),
      })
    ).status,
    401,
  );
  assert.equal((await call('login', { password }, '', 'https://attacker.example')).status, 403);
});
test('SQL-looking values are data, arbitrary commands/IDs are rejected, cookie logout revokes access', async () => {
  const cookie = await signed();
  const payload = "x'); DROP TABLE agenda_tasks; SELECT pg_sleep(10);--";
  assert.equal(
    (
      await call(
        'actions',
        {
          commands: [
            { op: 'create_task', title: payload, description: '<script>alert(1)</script>' },
          ],
          requestId: randomUUID(),
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.ok((await loadState(database)).tasks.some((t) => t.title === payload));
  assert.equal(
    (
      await call(
        'actions',
        { commands: [{ op: 'sql', sql: 'DROP TABLE agenda_tasks' }], requestId: randomUUID() },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal((await call('llm-providers/delete', { id: payload }, cookie)).status, 400);
  assert.equal(
    (
      await call(
        'actions',
        { commands: [{ op: 'create_task', title: 'CSRF' }], requestId: randomUUID() },
        cookie,
        'https://attacker.example',
      )
    ).status,
    403,
  );
  assert.equal((await call('logout', {}, cookie)).status, 200);
  assert.equal((await call('state', undefined, cookie)).status, 401);
});
test('rate limiting rejects repeated login guesses', async () => {
  for (let i = 0; i < 15; i++) await assert.rejects(login(req(), { password: 'wrong' }, database));
  await assert.rejects(login(req(), { password }, database), /Muitas tentativas/);
});
test('runtime role can perform app operations but cannot create or drop tables', async () => {
  const sql = await readFile(new URL('../scripts/runtime-role.sql', import.meta.url), 'utf8');
  for (const statement of sql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean))
    await database.query(statement);
  await database.query('SET ROLE agenda_runtime');
  try {
    await panelAction([{ op: 'create_task', title: 'Least privilege' }], randomUUID(), database);
    await assert.rejects(database.query('CREATE TABLE forbidden (id int)'));
    await assert.rejects(database.query('DROP TABLE agenda_tasks'));
    assert.ok((await loadState(database)).tasks.some((t) => t.title === 'Least privilege'));
  } finally {
    await database.query('RESET ROLE');
  }
});

test('hash gerado pelo script substitui a senha em texto no ambiente publicado', async () => {
  const { execFile } = await import('node:child_process');
  const segredo = 'senha-de-producao-2026';
  const run = (entrada: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = execFile('node', ['scripts/password-hash.mjs'], (error, stdout) =>
        resolve({ code: error ? 1 : 0, out: stdout }),
      );
      child.stdin!.end(`${entrada}\n`);
    });
  const { out } = await run(segredo);
  const linha = out.trim();
  assert.match(linha, /^PANEL_PASSWORD_HASH=[a-f\d]{32}:[a-f\d]{128}$/);
  // O formato precisa ser exatamente o que o login espera.
  process.env.PANEL_PASSWORD_HASH = linha.split('=')[1];
  delete process.env.PANEL_PASSWORD;
  try {
    assert.equal(verifyPassword(segredo), true);
    assert.equal(verifyPassword('senha errada'), false);
    // Dois hashes da mesma senha diferem: o sal é sorteado a cada vez.
    assert.notEqual((await run(segredo)).out.trim(), linha);
    // Senha curta demais não gera hash.
    assert.equal((await run('curta')).code, 1);
  } finally {
    delete process.env.PANEL_PASSWORD_HASH;
    process.env.PANEL_PASSWORD = password;
  }
});

test('falha de banco na API diz o que conferir em vez de um aviso genérico', async () => {
  const real = globals.agendaDb;
  const quebrado = (code: string): Database => ({
    query: async () => {
      throw Object.assign(new Error('detalhe interno do postgres'), { code });
    },
    transaction: async () => {
      throw Object.assign(new Error('detalhe interno do postgres'), { code });
    },
    read: async () => {
      throw Object.assign(new Error('detalhe interno do postgres'), { code });
    },
    close: async () => {},
  });
  const mensagem = async (code: string) => {
    globals.agendaDb = Promise.resolve(quebrado(code));
    const resposta = await call('login', { password });
    assert.equal(resposta.status, 500);
    return (await resposta.json()).error as string;
  };
  try {
    // Publicação sem migração: o banco responde, mas não tem as tabelas.
    assert.match(await mensagem('42P01'), /tabelas da agenda ainda não existem.*db:migrate/s);
    // Senha do banco trocada no provedor e não atualizada no ambiente publicado.
    assert.match(await mensagem('28P01'), /recusou as credenciais.*DATABASE_URL/s);
    assert.match(await mensagem('3D000'), /banco indicado em DATABASE_URL não existe/);
    assert.match(await mensagem('42501'), /não tem permissão.*usuário restrito/s);
    // Erro desconhecido mantém o aviso antigo, e nenhum deles repete o texto do banco.
    const desconhecido = await mensagem('XX000');
    assert.match(desconhecido, /Verifique a configuração e a conexão com o banco/);
    assert.ok(!desconhecido.includes('detalhe interno'), desconhecido);
  } finally {
    globals.agendaDb = real;
  }
});

test('origem aceita o APP_URL e os endereços que a própria Vercel entrega, e nada além', () => {
  const salvo = { ...process.env };
  const pedido = (origin: string) => new Request('https://x/api/login', { headers: { origin } });
  try {
    process.env.APP_URL = 'https://agenda.vercel.app';
    delete process.env.VERCEL;
    assert.doesNotThrow(() => sameOrigin(pedido('https://agenda.vercel.app')));
    assert.throws(() => sameOrigin(pedido('https://agenda-abc123.vercel.app')), /não autorizada/);

    // Publicado, o endereço próprio do deployment também vale: é o mesmo app, e é o link que
    // o painel da plataforma entrega.
    process.env.VERCEL = '1';
    process.env.VERCEL_URL = 'agenda-abc123.vercel.app';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'agenda.vercel.app';
    for (const origin of ['https://agenda.vercel.app', 'https://agenda-abc123.vercel.app'])
      assert.doesNotThrow(() => sameOrigin(pedido(origin)), origin);
    // Terceiros continuam barrados, inclusive quem imita o domínio.
    for (const origin of [
      'https://agenda.vercel.app.invasor.com',
      'http://agenda.vercel.app',
      'https://outro.vercel.app',
    ])
      assert.throws(() => sameOrigin(pedido(origin)), /não autorizada/, origin);
    // Sem cabeçalho de origem também é recusa.
    assert.throws(() => sameOrigin(new Request('https://x/api/login')), /não autorizada/);

    // A mensagem diz por onde entrar, em vez de só recusar.
    delete process.env.VERCEL;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    assert.throws(() => sameOrigin(pedido('https://errado.com')), /agenda\.vercel\.app/);
    // APP_URL ausente ou inválida cai no endereço local, sem aceitar qualquer origem.
    for (const valor of [undefined, 'não é url']) {
      if (valor === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = valor;
      assert.deepEqual(allowedOrigins(), ['http://localhost:3000']);
      assert.throws(() => sameOrigin(pedido('https://errado.com')), /não autorizada/);
    }
  } finally {
    process.env = salvo;
  }
});

test('configuração de banco ausente explica o que falta, em vez do aviso genérico', async () => {
  const real = globals.agendaDb;
  const modo = process.env.DATABASE_MODE;
  const url = process.env.DATABASE_URL;
  const vercel = process.env.VERCEL;
  const erro = async () => {
    // Sem conexão em cache, a rota reavalia a configuração do ambiente.
    delete globals.agendaDb;
    const resposta = await call('login', { password });
    return { status: resposta.status, texto: (await resposta.json()).error as string };
  };
  try {
    // Publicado com o banco embutido: o disco da função não guarda nada.
    process.env.VERCEL = '1';
    process.env.DATABASE_MODE = 'local';
    const embutido = await erro();
    assert.equal(embutido.status, 503);
    assert.match(embutido.texto, /disco da função é descartado/);
    assert.match(embutido.texto, /DATABASE_MODE=postgres e DATABASE_URL/);

    // Modo postgres sem a URL: é o que mais acontece no primeiro deploy.
    process.env.DATABASE_MODE = 'postgres';
    delete process.env.DATABASE_URL;
    const semUrl = await erro();
    assert.equal(semUrl.status, 503);
    assert.match(semUrl.texto, /Falta a conexão com o banco/);
    assert.match(semUrl.texto, /DATABASE_URL com a URL do Neon/);
    assert.doesNotMatch(semUrl.texto, /Verifique a configuração e a conexão/);
  } finally {
    if (modo === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = modo;
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    if (vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = vercel;
    globals.agendaDb = real;
  }
});
