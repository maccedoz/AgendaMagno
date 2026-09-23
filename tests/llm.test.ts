import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, loadState, type Database } from '../src/backend/db';
import { emptyState, DomainError, localDate } from '../src/backend/domain';
import { interpret } from '../src/backend/interpreter';
import {
  deleteProvider,
  generateCommands,
  isPublicAddress,
  listProviders,
  resetProvider,
  saveProvider,
  validateApiUrl,
  type LlmRequestOptions,
} from '../src/backend/llm';
import type { SaveLlmProviderInput } from '../src/backend/llm-types';

let database: Database;
const config = (overrides: Partial<SaveLlmProviderInput> = {}): SaveLlmProviderInput => ({
  name: 'IA principal',
  kind: 'compatible',
  model: 'example-model',
  apiUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 'secret-first-provider',
  priority: 1,
  enabled: true,
  dailyRequestLimit: 100,
  dailyTokenLimit: 0,
  ...overrides,
});
const success = (tokens = 31) =>
  Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({ commands: [{ op: 'create_task', title: 'Estudar' }] }),
        },
      },
    ],
    usage: { total_tokens: tokens },
  });
const fail = (status: number, headers?: Record<string, string>) =>
  Response.json({ error: 'Do not expose secret-first-provider' }, { status, headers });
before(async () => {
  process.env.LLM_ENCRYPTION_KEY = 'a'.repeat(64);
  database = await createDatabase();
});
beforeEach(async () => {
  await database.query('DELETE FROM agenda_llm_providers');
});
after(async () => {
  await database.close();
});

test('configurações persistem sem devolver chave, chave vazia preserva e a nova chave substitui', async () => {
  const saved = await saveProvider(config(), database);
  const provider = saved.providers[0];
  assert.equal(provider.keySet, true);
  assert.ok(!JSON.stringify(saved).includes('secret-first-provider'));
  const stored = JSON.stringify((await database.query('SELECT * FROM agenda_llm_providers')).rows);
  assert.ok(!stored.includes('secret-first-provider'));
  assert.ok(stored.includes('v1.'));
  await saveProvider(config({ id: provider.id, name: 'Renomeada', apiKey: '' }), database);
  const usedKeys: string[] = [];
  const sender: LlmRequestOptions['fetch'] = async (_url, init) => {
    usedKeys.push(new Headers(init.headers).get('authorization')!);
    return success();
  };
  await generateCommands('system', 'message', database, { fetch: sender });
  await saveProvider(config({ id: provider.id, apiKey: 'replacement-secret' }), database);
  await generateCommands('system', 'message', database, { fetch: sender });
  assert.deepEqual(usedKeys, ['Bearer secret-first-provider', 'Bearer replacement-secret']);
  await deleteProvider(provider.id, database);
  assert.equal((await listProviders(database)).providers.length, 0);
  assert.equal((await database.query('SELECT * FROM agenda_llm_usage')).rows.length, 0);
});

test('chave de criptografia inválida impede criação e nunca grava segredo em texto', async () => {
  process.env.LLM_ENCRYPTION_KEY = 'bad';
  try {
    await assert.rejects(saveProvider(config(), database), /LLM_ENCRYPTION_KEY/);
    assert.equal((await listProviders(database)).providers.length, 0);
  } finally {
    process.env.LLM_ENCRYPTION_KEY = 'a'.repeat(64);
  }
});

test('validação rejeita chaves ausentes, limites inválidos, URL insegura e campos inesperados', async () => {
  for (const invalid of [
    config({ apiKey: '' }),
    config({ dailyRequestLimit: 0 }),
    config({ dailyTokenLimit: -1 }),
    config({ apiUrl: 'http://api.example.com' }),
    config({ apiUrl: 'https://127.0.0.1/v1' }),
    config({ apiUrl: 'https://user:secret@api.example.com/v1' }),
    { ...config(), encrypted_key: 'untrusted' },
  ])
    await assert.rejects(saveProvider(invalid, database), DomainError);
  assert.equal((await listProviders(database)).providers.length, 0);
  for (const value of [
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://10.1.1.1/',
    'https://169.254.169.254/',
    'https://metadata.google.internal/',
    'https://localhost/',
    'https://127.1/',
    'https://2130706433/',
    'https://api.example.com/?key=secret',
    'https://api.example.com:8443/v1',
    'https://192.168.1.1/',
  ])
    assert.throws(() => validateApiUrl(value));
  for (const address of [
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '2002:7f00:1::',
    '2001:db8::1',
    '100.64.0.1',
    '192.0.0.1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});

test('429 troca por prioridade, respeita Retry-After e não divulga corpo de erro', async () => {
  const primary = (await saveProvider(config(), database)).providers[0];
  await saveProvider(config({ name: 'Reserva', priority: 2, apiKey: 'backup-key' }), database);
  const keys: string[] = [];
  const sender: LlmRequestOptions['fetch'] = async (_url, init) => {
    const key = new Headers(init.headers).get('authorization')!;
    keys.push(key);
    return key.includes('secret-first') ? fail(429, { 'retry-after': '3600' }) : success(47);
  };
  const result = await generateCommands('system', 'message', database, { fetch: sender });
  assert.deepEqual(result, [{ op: 'create_task', title: 'Estudar' }]);
  const status = (await listProviders(database)).providers;
  assert.equal(status[0].requestsToday, 1);
  assert.match(status[0].lastError!, /HTTP 429/);
  assert.ok(new Date(status[0].cooldownUntil!).getTime() > Date.now() + 3500000);
  assert.equal(status[1].tokensToday, 47);
  assert.ok(!JSON.stringify(status).includes('secret-first-provider'));
  await generateCommands('system', 'message', database, { fetch: sender });
  assert.equal(keys.filter((key) => key.includes('secret-first')).length, 1);
  await resetProvider(primary.id, database);
  const reset = (await listProviders(database)).providers[0];
  assert.equal(reset.cooldownUntil, null);
  assert.equal(reset.requestsToday, 1);
});

test('limites locais de requests e tokens pulam provedores antes de enviar e renovam no dia seguinte', async () => {
  await saveProvider(config({ dailyRequestLimit: 1 }), database);
  await saveProvider(
    config({ name: 'Token budget', priority: 2, apiKey: 'token-budget-key', dailyTokenLimit: 10 }),
    database,
  );
  await saveProvider(config({ name: 'Fallback', priority: 3, apiKey: 'last-key' }), database);
  const used: string[] = [];
  const sender: LlmRequestOptions['fetch'] = async (_url, init) => {
    used.push(new Headers(init.headers).get('authorization')!);
    return success(31);
  };
  for (let i = 0; i < 3; i++)
    await generateCommands('system', 'message', database, { fetch: sender });
  assert.deepEqual(used, [
    'Bearer secret-first-provider',
    'Bearer token-budget-key',
    'Bearer last-key',
  ]);
  await generateCommands('system', 'message', database, {
    fetch: sender,
    now: new Date(Date.now() + 86400000),
  });
  assert.equal(used[3], 'Bearer secret-first-provider');
});

test('reservas transacionais impedem exceder o limite de requisições em chamadas simultâneas', async () => {
  await saveProvider(config({ dailyRequestLimit: 1 }), database);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const sender: LlmRequestOptions['fetch'] = async () => {
    calls++;
    started();
    await gate;
    return success();
  };
  const first = generateCommands('system', 'message', database, { fetch: sender });
  await ready;
  await assert.rejects(
    generateCommands('system', 'second', database, { fetch: sender }),
    /Limite diário de chamadas do app/,
  );
  release();
  await first;
  assert.equal(calls, 1);
});

test('falhas de rede, crédito, chave inválida e 5xx permitem a próxima IA e guardam erros seguros', async () => {
  for (const status of [0, 402, 401, 403, 503]) {
    await database.query('DELETE FROM agenda_llm_providers');
    await saveProvider(config(), database);
    await saveProvider(config({ name: 'Reserva', priority: 2 }), database);
    let calls = 0;
    const result = await generateCommands('system', 'message', database, {
      fetch: async () => {
        if (++calls === 1) {
          if (status === 0) throw new Error('secret network error');
          return fail(status);
        }
        return success();
      },
    });
    assert.equal(result?.[0].op, 'create_task');
    const providers = (await listProviders(database)).providers;
    assert.ok(providers[0].lastError);
    assert.ok(!providers[0].lastError!.includes('secret'));
    if (status === 401 || status === 403) assert.match(providers[0].lastError!, /Chave inválida/);
  }
});

test('resposta JSON ou comandos inválidos interrompem sem tentar outra IA nem alterar agenda', async () => {
  await saveProvider(config(), database);
  await saveProvider(config({ name: 'Reserva', priority: 2 }), database);
  for (const invalid of ['not JSON', JSON.stringify({ commands: [{ op: 'delete_all_tasks' }] })]) {
    for (const item of (await listProviders(database)).providers)
      await resetProvider(item.id, database);
    let calls = 0;
    await assert.rejects(
      generateCommands('system', 'message', database, {
        fetch: async () => {
          calls++;
          return Response.json({
            choices: [{ message: { content: invalid } }],
            usage: { total_tokens: 8 },
          });
        },
      }),
      (error: unknown) => error instanceof DomainError && error.status === 422,
    );
    assert.equal(calls, 1);
  }
  assert.equal((await database.query('SELECT * FROM agenda_tasks')).rows.length, 0);
});

test('JSON entre cercas de markdown ou com texto em volta ainda é aceito', async () => {
  await saveProvider(config(), database);
  const object = JSON.stringify({ commands: [{ op: 'create_task', title: 'Proposta' }] });
  for (const content of [
    '```json\n' + object + '\n```',
    'Claro! Aqui está:\n' + object,
    object + '\n\nPosso ajudar em algo mais?',
  ]) {
    for (const item of (await listProviders(database)).providers)
      await resetProvider(item.id, database);
    const commands = await generateCommands('system', 'message', database, {
      fetch: async () =>
        Response.json({ choices: [{ message: { content } }], usage: { total_tokens: 8 } }),
    });
    assert.deepEqual(commands, [{ op: 'create_task', title: 'Proposta' }]);
  }
});

test('falha de formato diz qual etapa quebrou, sem repetir o texto do modelo', async () => {
  await saveProvider(config(), database);
  const cases: [unknown, RegExp][] = [
    [{ choices: [{ message: { content: '' } }] }, /sem texto/],
    [{ choices: [{ message: { content: 'desculpe, não posso' } }] }, /não em JSON|texto, n/],
    [{ choices: [{ message: { content: '{"resposta":"ok"}' } }] }, /sem a lista de ações/],
  ];
  for (const [body, expected] of cases) {
    for (const item of (await listProviders(database)).providers)
      await resetProvider(item.id, database);
    await assert.rejects(
      generateCommands('system', 'message', database, { fetch: async () => Response.json(body) }),
      (error: unknown) =>
        error instanceof DomainError && error.status === 422 && expected.test(error.message),
    );
    const [provider] = (await listProviders(database)).providers;
    assert.match(provider.lastError!, expected);
    assert.doesNotMatch(provider.lastError!, /desculpe|resposta/);
  }
});

test('comando com chave errada ou campo extra diz qual ação e qual campo falhou', async () => {
  await saveProvider(config(), database);
  const cases: [unknown, RegExp][] = [
    // O modelo chuta o nome da chave da operação em vez de "op".
    [[{ action: 'create_group', name: 'InfoJr' }], /ação 1.*(op|não previsto action)/],
    // O modelo aninha os campos, como em function calling.
    [[{ name: 'create_group', arguments: { name: 'InfoJr' } }], /ação 1.*arguments|ação 1.*op/],
    // A saudação convida o modelo a pendurar uma resposta social no comando.
    [
      [{ op: 'create_group', name: 'InfoJr', message: 'Olá! Criei o grupo InfoJr.' }],
      /ação 1: campo não previsto message/,
    ],
  ];
  for (const [commands, expected] of cases) {
    for (const item of (await listProviders(database)).providers)
      await resetProvider(item.id, database);
    await assert.rejects(
      generateCommands('system', 'message', database, {
        fetch: async () =>
          Response.json({
            choices: [{ message: { content: JSON.stringify({ commands }) } }],
            usage: { total_tokens: 8 },
          }),
      }),
      (error: unknown) =>
        error instanceof DomainError && error.status === 422 && expected.test(error.message),
    );
    const [provider] = (await listProviders(database)).providers;
    assert.match(provider.lastError!, expected);
    // O texto que o modelo escreveu nunca entra na mensagem: pode repetir dado pessoal.
    assert.doesNotMatch(provider.lastError!, /InfoJr|Olá/);
  }
});

test('o prompt leva as últimas 3 trocas da conversa, cortadas e só dentro da janela', async () => {
  await saveProvider(config(), database);
  const agora = new Date();
  const antiga = new Date(agora.getTime() - 45 * 60000).toISOString();
  // Quatro trocas dentro da janela (só as 3 últimas devem ir) e uma fora dela.
  for (const [i, texto] of ['alfa', 'beta', 'gama', 'delta'].entries())
    await database.query(
      `INSERT INTO agenda_messages(id,external_id,channel,body,reply,status,received_at)
       VALUES($1,$2,'web',$3,$4,'done',now() - ($5 || ' seconds')::interval)`,
      [`mem-${i}`, `web:mem-${i}`, texto, `resposta ${texto}`, String((4 - i) * 10)],
    );
  await database.query(
    `INSERT INTO agenda_messages(id,external_id,channel,body,reply,status,received_at)
     VALUES('mem-velha','web:mem-velha','web','mensagem velha','resposta velha','done',$1)`,
    [antiga],
  );
  await database.query(
    `INSERT INTO agenda_messages(id,external_id,channel,body,reply,status,received_at)
     VALUES('mem-longa','web:mem-longa','web',$1,NULL,'done',now())`,
    ['x'.repeat(900)],
  );
  let enviado = '';
  await interpret(emptyState(), 'muda pra sexta', 'web', agora, database, {
    fetch: async (_url, init) => {
      enviado = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({
        choices: [{ message: { content: '{"commands":[{"op":"help"}]}' } }],
        usage: { total_tokens: 5 },
      });
    },
  });
  assert.match(enviado, /Conversa recente/);
  // Só as 3 mais recentes: "alfa" ficou de fora.
  assert.doesNotMatch(enviado, /alfa/);
  assert.match(enviado, /delta/);
  assert.match(enviado, /gama/);
  // Fora da janela de 30 minutos não entra.
  assert.doesNotMatch(enviado, /mensagem velha/);
  // Cada mensagem entra cortada.
  assert.doesNotMatch(enviado, /x{500}/);
});

test('apagar a conversa some com o texto, preserva a dedup e esquece o contexto', async () => {
  const { chat, clearChat, snapshot } = await import('../src/backend/service');
  const feito = await chat('Anota: segredo pessoal', 'limpar-1', database);
  assert.equal(feito.status, 'done');
  assert.equal(
    (await snapshot(database)).messages.some((m) =>
      String(m.body ?? '').includes('segredo pessoal'),
    ),
    true,
  );
  const limpo = await clearChat(database);
  assert.ok(limpo.cleared >= 1);
  const depois = await snapshot(database);
  assert.equal(
    depois.messages.some((m) => String(m.body ?? '').includes('segredo pessoal')),
    false,
  );
  // A linha continua existindo: repetir o mesmo requestId não pode criar a tarefa de novo.
  const antes = (await loadState(database)).tasks.length;
  await chat('Anota: segredo pessoal', 'limpar-1', database);
  assert.equal((await loadState(database)).tasks.length, antes);
  // E o assistente não leva mais a conversa apagada para o modelo.
  await saveProvider(config(), database);
  let enviado = '';
  await interpret(emptyState(), 'e agora?', 'web', new Date(), database, {
    fetch: async (_url, init) => {
      enviado = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({
        choices: [{ message: { content: '{"commands":[{"op":"help"}]}' } }],
        usage: { total_tokens: 5 },
      });
    },
  });
  assert.doesNotMatch(enviado, /segredo pessoal/);
  // O banco é compartilhado entre os testes deste arquivo, que assumem agenda vazia.
  await database.query('DELETE FROM agenda_tasks');
  await database.query("DELETE FROM agenda_messages WHERE channel='web'");
});

test('o prompt entrega a semana já resolvida e manda o prazo sair do título', async () => {
  await saveProvider(config(), database);
  let enviado = '';
  // 21/09/2026 é uma segunda-feira; a quinta seguinte é 24/09/2026.
  await interpret(
    emptyState(),
    'adicione em infojr proposta até quinta',
    'web',
    new Date('2026-09-21T15:00:00-03:00'),
    database,
    {
      fetch: async (_url, init) => {
        enviado = JSON.parse(String(init.body)).messages[0].content;
        return Response.json({
          choices: [{ message: { content: '{"commands":[{"op":"help"}]}' } }],
          usage: { total_tokens: 5 },
        });
      },
    },
  );
  assert.match(enviado, /segunda-feira 2026-09-21 \(hoje\)/);
  assert.match(enviado, /terça-feira 2026-09-22 \(amanhã\)/);
  assert.match(enviado, /quinta-feira 2026-09-24/);
  assert.match(enviado, /SAI do título/);
});

test('o prompt mostra ao modelo a chave "op" e um exemplo literal de resposta', async () => {
  await saveProvider(config(), database);
  let sent = '';
  await interpret(emptyState(), 'olá, crie um grupo chamado InfoJr', 'web', new Date(), database, {
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({
        choices: [{ message: { content: '{"commands":[{"op":"create_group","name":"InfoJr"}]}' } }],
        usage: { total_tokens: 8 },
      });
    },
  });
  assert.match(sent, /"op"/);
  assert.match(sent, /\{"commands":\[\{"op":"create_group"/);
  assert.match(sent, /clarify/);
});

test('Gemini usa chave no cabeçalho, lê metadados e ignora partes de raciocínio', async () => {
  await saveProvider(
    config({ kind: 'gemini', model: 'models/gemini-example', apiUrl: '' }),
    database,
  );
  await generateCommands('system prompt', 'message', database, {
    fetch: async (url, init) => {
      assert.equal(
        url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-example:generateContent',
      );
      assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'secret-first-provider');
      assert.equal(init.redirect, 'error');
      assert.equal(JSON.parse(String(init.body)).systemInstruction.parts[0].text, 'system prompt');
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'internal thought' },
                { text: '{"commands":[{"op":"help"}]}' },
              ],
            },
          },
        ],
        usageMetadata: { totalTokenCount: 55 },
      });
    },
  });
  assert.equal((await listProviders(database)).providers[0].tokensToday, 55);
});

test('todos indisponíveis falham com mensagem segura e tentativas limitadas', async () => {
  for (let i = 0; i < 6; i++)
    await saveProvider(config({ name: `IA ${i}`, priority: i }), database);
  let calls = 0;
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () => {
        calls++;
        return fail(429);
      },
    }),
    /Nenhuma alteração/,
  );
  assert.equal(calls, 4);
  assert.equal((await database.query('SELECT * FROM agenda_tasks')).rows.length, 0);
});

test('com IA cadastrada, mesmo frases em formato conhecido vão para a IA', async () => {
  await saveProvider(config(), database);
  // A regex de "adicione" resolveria isto ao pé da letra: criaria uma tarefa chamada
  // "em infojr proposta até quinta", sem grupo e sem prazo. A IA precisa receber a frase.
  const frase = 'adicione em infojr proposta até quinta';
  let enviado = '';
  const commands = await interpret(emptyState(), frase, 'web', new Date(), database, {
    fetch: async (_url, init) => {
      enviado = JSON.parse(String(init.body)).messages[1].content;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                commands: [
                  { op: 'create_task', title: 'proposta', group: 'infojr', dueDate: '2026-09-24' },
                ],
              }),
            },
          },
        ],
        usage: { total_tokens: 12 },
      });
    },
  });
  assert.equal(enviado, frase);
  assert.deepEqual(commands, [
    { op: 'create_task', title: 'Proposta', group: 'infojr', dueDate: '2026-09-24' },
  ]);
  // Formatos exatos e triviais também passam a consultar a IA.
  for (const trivial of ['ajuda', 'Anota: comprar pilhas', 'Finalizei #1']) {
    let chamou = false;
    await interpret(emptyState(), trivial, 'web', new Date(), database, {
      fetch: async () => {
        chamou = true;
        return Response.json({
          choices: [{ message: { content: '{"commands":[{"op":"help"}]}' } }],
          usage: { total_tokens: 5 },
        });
      },
    });
    assert.equal(chamou, true, `"${trivial}" deveria consultar a IA`);
  }
});

test('sem nenhuma IA cadastrada, os formatos exatos ainda respondem', async () => {
  const commands = await interpret(
    emptyState(),
    'Anota: Comprar pilhas',
    'web',
    new Date(),
    database,
  );
  assert.equal(commands[0].op, 'create_task');
  const fallback = await interpret(
    emptyState(),
    'Um pedido livre desconhecido',
    'web',
    new Date(),
    database,
  );
  assert.equal(fallback[0].op, 'clarify');
  assert.equal((await database.query('SELECT * FROM agenda_llm_usage')).rows.length, 0);
});

test('reservas de tokens abandonadas expiram e não bloqueiam o provedor pelo resto do dia', async () => {
  const provider = (await saveProvider(config({ dailyTokenLimit: 100 }), database)).providers[0];
  await database.query(
    'INSERT INTO agenda_llm_usage (provider_id,day,requests,reserved_tokens,reserved_until) VALUES ($1,$2,1,1000,$3)',
    [provider.id, localDate(new Date()), new Date(Date.now() - 1000).toISOString()],
  );
  const commands = await generateCommands('system', 'message', database, {
    fetch: async () => success(),
  });
  assert.equal(commands?.[0].op, 'create_task');
});

test('timeout não vira falta de cota nem soma estimativa como consumo confirmado', async () => {
  await saveProvider(config({ dailyTokenLimit: 250000 }), database);
  const now = new Date();
  await generateCommands('system', 'primeira mensagem', database, {
    fetch: async () => success(5000),
    now,
  });
  await assert.rejects(
    generateCommands('system', 'segunda mensagem', database, {
      now,
      fetch: async (_url, init) => {
        assert.equal(init.signal?.aborted, false);
        throw new DOMException('private request data', 'TimeoutError');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.match(error.message, /demorou além do tempo/);
      assert.match(error.message, /Nova tentativa em 1 min/);
      assert.doesNotMatch(error.message, /sem cota|250\.000|private request/);
      return true;
    },
  );
  const [provider] = (await listProviders(database)).providers;
  assert.equal(provider.tokensToday, 5000);
  assert.equal(provider.reportedTokensToday, 5000);
  assert.equal(provider.estimatedTokensToday, 0);
  assert.equal(provider.unconfirmedRequestsToday, 1);
  assert.equal(provider.requestsToday, 2);
  const usage = (
    await database.query<{ reserved_tokens: string }>(
      'SELECT reserved_tokens FROM agenda_llm_usage',
    )
  ).rows[0];
  assert.equal(Number(usage.reserved_tokens), 0);
  let called = false;
  await assert.rejects(
    generateCommands('system', 'durante pausa', database, {
      now: new Date(now.getTime() + 10000),
      fetch: async () => {
        called = true;
        return success();
      },
    }),
    /demorou além do tempo.*Nova tentativa em \d+ s/,
  );
  assert.equal(called, false);
  const resumed = await generateCommands('system', 'depois da pausa', database, {
    now: new Date(now.getTime() + 65000),
    fetch: async () => success(15),
  });
  assert.equal(resumed?.[0].op, 'create_task');
});

test('erro de rede permite fallback sem inflar contagem e sem vazar mensagem upstream', async () => {
  await saveProvider(config(), database);
  await saveProvider(config({ name: 'Reserva', priority: 2 }), database);
  let calls = 0;
  await generateCommands('system', 'message', database, {
    fetch: async () => {
      if (++calls === 1) throw new Error('secret-first-provider');
      return success(7);
    },
  });
  const [first, second] = (await listProviders(database)).providers;
  assert.equal(first.tokensToday, 0);
  assert.equal(first.unconfirmedRequestsToday, 1);
  assert.equal(second.reportedTokensToday, 7);
  assert.match(first.lastError!, /Falha de conexão/);
  assert.doesNotMatch(first.lastError!, /secret-first/);
});

test('429 sem Retry-After pausa por um minuto e explica limites de frequência', async () => {
  await saveProvider(config(), database);
  const now = new Date();
  await assert.rejects(
    generateCommands('system', 'message', database, {
      now,
      fetch: async () => fail(429),
    }),
    /HTTP 429.*por minuto ou por dia/,
  );
  const [provider] = (await listProviders(database)).providers;
  const delay = new Date(provider.cooldownUntil!).getTime() - now.getTime();
  assert.ok(delay >= 60000 && delay < 65000);
  assert.equal(provider.tokensToday, 0);
});

test('429 Gemini respeita RetryInfo sem divulgar detalhes da requisição', async () => {
  await saveProvider(config({ kind: 'gemini', apiUrl: '' }), database);
  const now = new Date();
  await assert.rejects(
    generateCommands('system', 'message', database, {
      now,
      fetch: async () =>
        Response.json(
          {
            error: {
              message: 'secret',
              details: [
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '8.5s' },
              ],
            },
          },
          { status: 429 },
        ),
    }),
    /Nova tentativa em 9 s/,
  );
  const [provider] = (await listProviders(database)).providers;
  assert.doesNotMatch(provider.lastError!, /secret/);
  const delay = new Date(provider.cooldownUntil!).getTime() - now.getTime();
  assert.ok(delay >= 8500 && delay < 10000);
});

test('limite local de tokens informa números e não é confundido com o saldo da API', async () => {
  await saveProvider(config({ dailyTokenLimit: 100 }), database);
  await generateCommands('system', 'message', database, { fetch: async () => success(120) });
  let calls = 0;
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () => {
        calls++;
        return success();
      },
    }),
    /Limite diário de tokens do app atingido \(120\/100\).*não consulta o saldo/,
  );
  assert.equal(calls, 0);
});

test('resposta sem metadados recebe estimativa separada, sem cobrar o máximo de saída', async () => {
  await saveProvider(config(), database);
  await generateCommands('system', 'message', database, {
    fetch: async () =>
      Response.json({
        choices: [{ message: { content: '{"commands":[{"op":"help"}]}' } }],
      }),
  });
  const [provider] = (await listProviders(database)).providers;
  assert.equal(provider.reportedTokensToday, 0);
  assert.ok(provider.estimatedTokensToday > 0 && provider.estimatedTokensToday < 100);
  assert.equal(provider.tokensToday, provider.estimatedTokensToday);
});

test('migração preserva contadores antigos e identifica que não são consumo confirmado', async () => {
  const provider = (await saveProvider(config(), database)).providers[0];
  await database.query(
    'INSERT INTO agenda_llm_usage(provider_id,day,requests,tokens) VALUES($1,$2,17,45991)',
    [provider.id, localDate(new Date())],
  );
  await generateCommands('system', 'message', database, { fetch: async () => success(10) });
  const [saved] = (await listProviders(database)).providers;
  assert.equal(saved.tokensToday, 46001);
  assert.equal(saved.legacyTokensToday, 45991);
  assert.equal(saved.reportedTokensToday, 10);
  assert.equal(saved.estimatedTokensToday, 0);
});

test('erro da API aponta a causa pelo código estruturado, sem repetir o texto do provedor', async () => {
  const casos = [
    {
      // Endereço base em vez do endpoint completo: a recusa mais comum ao cadastrar uma API.
      status: 404,
      body: {
        error: {
          message: 'Unknown request URL: POST /openai/v1. Please check the URL for typos.',
          type: 'invalid_request_error',
          code: 'unknown_url',
        },
      },
      espera: [/endpoint completo de Chat Completions/, /código unknown_url/],
    },
    {
      status: 400,
      body: { error: { message: 'segredo da pessoa no texto', code: 'model_not_found' } },
      espera: [/aceita resposta em JSON/, /código model_not_found/],
    },
    {
      // Gemini usa outro nome para o mesmo campo.
      status: 403,
      body: { error: { message: 'detalhe extenso', status: 'PERMISSION_DENIED' } },
      espera: [/Chave inválida ou sem permissão/, /código PERMISSION_DENIED/],
    },
    {
      // Uma frase no lugar do código não atravessa: só identificadores curtos passam.
      status: 400,
      body: { error: { code: 'a mensagem inteira da pessoa vazando por aqui' } },
      espera: [/aceita resposta em JSON/],
    },
  ];
  for (const caso of casos) {
    const provider = (await saveProvider(config(), database)).providers[0];
    await assert.rejects(
      generateCommands('system', 'message', database, {
        fetch: async () => Response.json(caso.body, { status: caso.status }),
      }),
    );
    const erro = (await listProviders(database)).providers[0].lastError!;
    for (const padrao of caso.espera) assert.match(erro, padrao, `${caso.status}: ${erro}`);
    assert.ok(!erro.includes('segredo da pessoa'), erro);
    assert.ok(!erro.includes('Please check the URL'), erro);
    assert.ok(!erro.includes('vazando por aqui'), erro);
    await deleteProvider(provider.id, database);
  }
});

test('modelo que recusa json_object ganha segunda tentativa sem o campo, na mesma API', async () => {
  await saveProvider(config(), database);
  const enviados: Record<string, unknown>[] = [];
  const result = await generateCommands('system', 'message', database, {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      enviados.push(body);
      // Modelos de raciocínio recusam o formato, e a recusa vem como HTTP 400.
      return body.response_format
        ? Response.json(
            {
              error: {
                message: 'json_object is not supported with this model',
                type: 'invalid_request_error',
                param: 'response_format',
              },
            },
            { status: 400 },
          )
        : success(31);
    },
  });
  assert.deepEqual(result, [{ op: 'create_task', title: 'Estudar' }]);
  assert.equal(enviados.length, 2);
  assert.equal((enviados[0].response_format as { type: string }).type, 'json_object');
  assert.equal(enviados[1].response_format, undefined);
  // A primeira recusa não pausa o provedor: ele acabou de responder certo na segunda.
  const status = (await listProviders(database)).providers[0];
  assert.equal(status.lastError, null);
  assert.equal(status.cooldownUntil, null);
  // As duas chamadas são cobradas, porque as duas saíram de fato.
  assert.equal(status.requestsToday, 2);
});

test('recusa persistente registra o campo apontado pela API, sem o texto dela', async () => {
  await saveProvider(config(), database);
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () =>
        Response.json(
          { error: { message: 'texto da pessoa aqui', code: 'decommissioned', param: 'model' } },
          { status: 400 },
        ),
    }),
  );
  const erro = (await listProviders(database)).providers[0].lastError!;
  assert.match(erro, /código decommissioned/);
  assert.match(erro, /Campo recusado: model/);
  assert.ok(!erro.includes('texto da pessoa'), erro);
});

test('Gemini 2.5 Flash responde sem raciocínio, que consumia a saída e a espera', async () => {
  await saveProvider(config({ kind: 'gemini', model: 'gemini-2.5-flash', apiUrl: '' }), database);
  await saveProvider(
    config({
      name: 'Pro',
      kind: 'gemini',
      model: 'gemini-2.5-pro',
      apiUrl: '',
      priority: 2,
      apiKey: 'pro-key',
      enabled: false,
    }),
    database,
  );
  const corpo = async (fetchBody: (b: any) => void) => {
    await generateCommands('system', 'message', database, {
      fetch: async (_url, init) => {
        fetchBody(JSON.parse(String(init.body)));
        return Response.json({
          candidates: [{ content: { parts: [{ text: '{"commands":[{"op":"help"}]}' }] } }],
          usageMetadata: { totalTokenCount: 12 },
        });
      },
    });
  };
  let flash: any;
  await corpo((b) => (flash = b));
  assert.equal(flash.generationConfig.thinkingConfig.thinkingBudget, 0);
  // O 2.5 Pro não aceita desligar o raciocínio; mandar o campo para ele seria outra recusa.
  const providers = (await listProviders(database)).providers;
  await saveProvider(
    {
      ...config({ apiUrl: '' }),
      id: providers[0].id,
      kind: 'gemini',
      model: 'gemini-2.5-pro',
      apiKey: undefined,
    },
    database,
  );
  let pro: any;
  await corpo((b) => (pro = b));
  assert.equal(pro.generationConfig.thinkingConfig, undefined);
  assert.equal(pro.generationConfig.maxOutputTokens, 2048);
});

test('tipo Gemini usado para modelo de outro serviço explica a escolha errada', async () => {
  await saveProvider(config({ kind: 'gemini', model: 'gpt-oss-120b', apiUrl: '' }), database);
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () =>
        Response.json(
          { error: { message: 'texto do Google', status: 'INVALID_ARGUMENT' } },
          { status: 400 },
        ),
    }),
  );
  const erro = (await listProviders(database)).providers[0].lastError!;
  assert.match(erro, /código INVALID_ARGUMENT/);
  assert.match(erro, /apenas com a API do Google/);
  assert.match(erro, /Compatível com Chat Completions/);
  assert.ok(!erro.includes('texto do Google'), erro);
  // Já uma API compatível recusada não recebe esse aviso: o tipo dela está certo.
  await saveProvider(config({ name: 'Compatível', priority: 2, apiKey: 'outra' }), database);
  await deleteProvider((await listProviders(database)).providers[0].id, database);
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () => Response.json({ error: { code: 'model_not_found' } }, { status: 404 }),
    }),
  );
  assert.doesNotMatch((await listProviders(database)).providers[0].lastError!, /API do Google/);
});

test('endereço de site em vez de endpoint é nomeado, por redirecionamento ou por HTML', async () => {
  // O painel do serviço redireciona; a agenda não segue redirecionamento, então o pedido para
  // aqui sem nenhuma pista sobre o que está errado.
  await saveProvider(config({ apiUrl: 'https://console.exemplo.com/' }), database);
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () => new Response('', { status: 307, headers: { location: '/login' } }),
    }),
  );
  const redirecionou = (await listProviders(database)).providers[0].lastError!;
  assert.match(redirecionou, /redirecionamento, que não é seguido/);
  assert.match(redirecionou, /api\.groq\.com\/openai\/v1\/chat\/completions/);
  await resetProvider((await listProviders(database)).providers[0].id, database);

  // Já uma página de documentação responde HTML com status comum.
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () =>
        new Response('<!doctype html><title>Docs</title>', {
          status: 405,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    }),
  );
  const html = (await listProviders(database)).providers[0].lastError!;
  assert.match(html, /veio em HTML, não em JSON/);
  assert.match(html, /página web, não o endpoint/);
  await resetProvider((await listProviders(database)).providers[0].id, database);

  // Uma API de verdade que recusa não recebe nenhum desses avisos.
  await assert.rejects(
    generateCommands('system', 'message', database, {
      fetch: async () => Response.json({ error: { code: 'model_not_found' } }, { status: 404 }),
    }),
  );
  const api = (await listProviders(database)).providers[0].lastError!;
  assert.doesNotMatch(api, /HTML|redirecionamento/);
  assert.match(api, /endpoint completo de Chat Completions/);
});

test('financeiro usa categorias no mesmo pedido, omite tarefas e não aceita confirmação inventada', async () => {
  await saveProvider(config(), database);
  const state = emptyState();
  state.tasks.push({
    id: 999,
    title: 'Título de tarefa privado',
    description: '',
    groupId: null,
    status: 'pending',
    priority: 'normal',
    dueDate: null,
    dueTime: null,
    completedAt: null,
    trashedAt: null,
    purgeAt: null,
    trashReason: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let calls = 0,
    prompt = '';
  const commands = await interpret(
    state,
    'Gastei 42,90 no almoço hoje',
    'finance-test',
    new Date(),
    database,
    {
      fetch: async (_url, init) => {
        calls++;
        prompt = JSON.parse(String(init.body)).messages[0].content;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commands: [
                    {
                      op: 'finance_create',
                      kind: 'expense',
                      amount: '42,90',
                      description: 'Almoço',
                      category: 'Alimentação',
                    },
                  ],
                }),
              },
            },
          ],
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(commands[0].amount, '42,90');
  assert.match(prompt, /Alimentação/);
  assert.doesNotMatch(prompt, /Título de tarefa privado/);
  const deletion = await interpret(
    state,
    'Exclua o lançamento Almoço',
    'finance-test',
    new Date(),
    database,
    {
      fetch: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commands: [{ op: 'finance_delete', entry: 'Almoço', confirmed: true }],
                }),
              },
            },
          ],
        }),
    },
  );
  assert.equal(deletion[0].confirmed, undefined);
});

test('conversa financeira recente não esconde tarefas e grupos do pedido seguinte', async () => {
  await saveProvider(config(), database);
  const state = emptyState();
  state.groups.push({
    id: 'g1',
    name: 'Estudos',
    color: 'verde',
    icon: 'book',
    order: 0,
    archivedAt: null,
    createdAt: new Date().toISOString(),
  });
  state.tasks.push({
    id: 501,
    title: 'Ler capítulo três',
    description: '',
    groupId: 'g1',
    status: 'pending',
    priority: 'normal',
    dueDate: null,
    dueTime: null,
    completedAt: null,
    trashedAt: null,
    purgeAt: null,
    trashReason: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Uma mensagem financeira antiga fica na memória de 30 minutos do canal.
  await database.query(
    `INSERT INTO agenda_messages(id,external_id,channel,body,reply,status)
     VALUES($1,$2,'memoria-financeira','gastei 10 reais com uber','Despesa registrada.','done')`,
    [randomUUID(), `memoria:${randomUUID()}`],
  );
  let prompt = '';
  await interpret(state, 'adicione leite', 'memoria-financeira', new Date(), database, {
    fetch: async (_url, init) => {
      prompt = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ commands: [{ op: 'create_task', title: 'leite' }] }),
            },
          },
        ],
      });
    },
  });
  // A guarda do próprio teste: sem a conversa recente no prompt, ele não provaria nada.
  assert.match(prompt, /gastei 10 reais com uber/);
  assert.match(prompt, /Estudos/);
  assert.match(prompt, /Ler capítulo três/);
});

test('resposta a uma pergunta livre da IA volta junto com o pedido original', async () => {
  await saveProvider(config(), database);
  await database.query(
    `INSERT INTO agenda_messages(id,external_id,channel,body,reply,status,received_at)
     VALUES('pergunta-livre','pergunta-livre','web-pergunta',$1,$2,'clarification',$3)`,
    ['crie uma tarefa de dentista', 'Para qual dia?', new Date().toISOString()],
  );
  let sistema = '';
  await interpret(emptyState(), 'amanhã', 'web-pergunta', new Date(), database, {
    fetch: async (_url, init) => {
      sistema = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ commands: [{ op: 'create_task', title: 'dentista' }] }),
            },
          },
        ],
        usage: { total_tokens: 12 },
      });
    },
  });
  // Sem isto o "amanhã" chegava à IA como pedido novo, sem saber do dentista.
  assert.match(sistema, /terminou com uma pergunta da agenda/);
  assert.match(sistema, /crie uma tarefa de dentista/);
  assert.match(sistema, /Para qual dia\?/);
});
