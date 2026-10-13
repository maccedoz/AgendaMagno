import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, loadState, type Database } from '../src/backend/db';
import { type Command } from '../src/backend/domain';
import { interpret } from '../src/backend/interpreter';
import { listProviders, saveProvider } from '../src/backend/llm';
import { fixedUsage } from '../src/backend/finance/plan';
import { chat, panelAction } from '../src/backend/service';
import {
  financeCompare,
  financePlan,
  saveFinancePlanItem,
} from '../src/backend/finance/plan-store';
import { financeSnapshot, loadFinance } from '../src/backend/finance/store';

let database: Database;
before(async () => {
  process.env.LLM_ENCRYPTION_KEY = 'a'.repeat(64);
  database = await createDatabase();
});
after(async () => database.close());
beforeEach(async () => {
  for (const table of [
    'agenda_messages',
    'agenda_conversations',
    'agenda_history',
    'agenda_operations',
    'agenda_finance_plan',
    'agenda_finance_entries',
    'agenda_llm_providers',
  ])
    await database.query(`DELETE FROM ${table}`);
  await saveProvider(
    {
      name: 'Modelo de teste',
      kind: 'compatible',
      model: 'test-model',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'test-only-key',
      priority: 1,
      enabled: true,
      dailyRequestLimit: 100,
      dailyTokenLimit: 0,
    },
    database,
  );
});

// A resposta da API é simulada, mas o prompt, a validação, a execução e a persistência são reais.
function model(
  commands: Command[],
  inspect?: (system: string, text: string) => void,
): typeof interpret {
  return (state, text, channel, now, connection) =>
    interpret(state, text, channel, now, connection, {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        inspect?.(body.messages[0].content, body.messages[1].content);
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ commands }) } }],
          usage: { total_tokens: 100 },
        });
      },
    });
}
const expenses = [
  ['Conta de Luz', '60,00', 6000],
  ['Internet(Móvel + Fixa)', '105,00', 10500],
  ['Aluguel', '450,00', 45000],
  ['Academia', '40,00', 4000],
  ['YT + Meli + Spotify', '46,00', 4600],
  ['Dentista', '80,00', 8000],
  ['Melhorias', '300,00', 30000],
  ['Cabelo', '35,00', 3500],
  ['Besteiras', '300,00', 30000],
  ['IA', '100,00', 10000],
] as const;
const request =
  expenses.map(([name, amount]) => `${name}\tR$ ${amount}`).join(' ') +
  ' adicione isso no planejamento como despesas fixas';
const commands: Command[] = expenses.map(([name, amount]) => ({
  op: 'finance_plan_create',
  planKind: 'fixed',
  name,
  amount,
}));

test('lista de dez despesas vai para gastos fixos sem criar lançamentos, categorias ou duplicatas', async () => {
  const before = await loadFinance(database);
  const id = randomUUID();
  let calls = 0;
  const interpreter = model(commands, (system, text) => {
    calls++;
    assert.equal(text, request);
    assert.match(system, /finance_plan_create\(planKind/);
    assert.match(system, /gastos\/despesas\/dívidas fixas/);
    assert.match(system, /Dez despesas fixas cabem em dez ações/);
    assert.match(system, /não crie categorias extras/);
  });
  const rewrite = async () => {
    assert.fail('O resultado financeiro deve usar os valores calculados no servidor.');
  };
  const result = await chat(request, id, database, interpreter, rewrite);
  assert.equal(result.status, 'done', result.error ?? undefined);
  assert.match(result.reply!, /Gasto fixo adicionado ao planejamento/);
  const data = await financePlan({}, database);
  assert.equal(data.items.length, 10);
  for (const [name, , cents] of expenses) {
    const item = data.items.find((x) => x.name === name)!;
    assert.ok(item, name);
    assert.equal(item.kind, 'fixed');
    assert.equal(item.amountCents, cents);
    assert.equal(item.categoryId, null);
  }
  assert.equal(
    data.items.reduce((sum, x) => sum + x.amountCents, 0),
    151600,
  );
  assert.deepEqual(data.real, { income: 0, expense: 0, byCategory: [] });
  const after = await loadFinance(database);
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.templates, before.templates);
  assert.deepEqual(after.categories, before.categories);
  assert.deepEqual(await chat(request, id, database, interpreter, rewrite), result);
  assert.equal(calls, 1);
  assert.equal((await financePlan({}, database)).items.length, 10);
});

test('nome repetido no lote é mantido e avisado, e os demais itens entram', async () => {
  await saveFinancePlanItem({ kind: 'fixed', name: 'IA', amount: '99,00' }, database);
  await saveFinancePlanItem({ kind: 'fixed', name: 'Aluguel', amount: '450,00' }, database);
  const result = await chat(request, randomUUID(), database, model(commands));
  assert.equal(result.status, 'done', result.error ?? undefined);
  assert.match(result.reply!, /Aluguel já estava no planejamento/);
  assert.match(result.reply!, /IA já está no planejamento com R\$\s*99,00.*pediu R\$\s*100,00/);
  const items = (await financePlan({}, database)).items;
  assert.equal(items.length, 10);
  assert.equal(items.find((x) => x.name === 'IA')!.amountCents, 9900);
  assert.equal(items.filter((x) => x.name === 'Aluguel').length, 1);
});

test('valor ausente pergunta e retoma todos os gastos fixos sem gravar um lote parcial', async () => {
  const incomplete: Command[] = [
    commands[0],
    { op: 'finance_plan_create', planKind: 'fixed', name: 'Internet' },
  ];
  const result = await chat(
    'Adicione luz 60 e internet nos fixos',
    randomUUID(),
    database,
    model(incomplete),
  );
  assert.equal(result.status, 'clarification');
  assert.match(result.reply!, /valor mensal/);
  assert.equal((await financePlan({}, database)).items.length, 0);
  const completed = await chat(
    '105,00',
    randomUUID(),
    database,
    model([], () => assert.fail('Resposta pendente não deve chamar IA')),
  );
  assert.equal(completed.status, 'done', completed.error ?? undefined);
  assert.equal((await financePlan({}, database)).items.length, 2);
  assert.equal((await loadFinance(database)).entries.length, 0);
});

test('consultar dívidas fixas usa o contexto e os totais do planejamento, sem confundir com pagamentos', async () => {
  await saveFinancePlanItem({ kind: 'fixed', name: 'Conta fixa de teste', amount: '60' }, database);
  await saveFinancePlanItem({ kind: 'income', name: 'Renda mensal', amount: '3000' }, database);
  await panelAction(
    [{ op: 'finance_create', kind: 'expense', description: 'Pago hoje', amount: '10' }],
    randomUUID(),
    database,
  );
  const before = await loadFinance(database);
  const result = await chat(
    'Quais são minhas dívidas fixas?',
    randomUUID(),
    database,
    model([{ op: 'finance_plan_list', planKind: 'fixed' }], (system) =>
      assert.match(system, /"name":"Conta fixa de teste"/),
    ),
  );
  assert.equal(result.status, 'done', result.error ?? undefined);
  assert.match(result.reply!, /Conta fixa de teste/);
  assert.match(result.reply!, /gastos fixos R\$\s*60,00/);
  assert.doesNotMatch(result.reply!, /Pago hoje/);
  assert.deepEqual(await loadFinance(database), before);
});

test('renda e limite mensal usam as regras do painel e ficam fora do saldo realizado', async () => {
  const result = await chat(
    'Planeje renda de 3000 e limite de alimentação de 500',
    randomUUID(),
    database,
    model([
      { op: 'finance_plan_create', planKind: 'income', name: 'Salário', amount: '3.000,00' },
      { op: 'finance_plan_create', planKind: 'budget', category: 'Alimentação', amount: '500,00' },
    ]),
  );
  assert.equal(result.status, 'done', result.error ?? undefined);
  const data = await financePlan({}, database);
  assert.equal(data.items.length, 2);
  assert.equal(
    data.items.find((x) => x.kind === 'budget')?.categoryId,
    '00000000-0000-4000-8000-000000000003',
  );
  assert.deepEqual((await financeSnapshot({}, database)).totals, {
    income: 0,
    expense: 0,
    result: 0,
  });
  const invalid = await chat(
    'Limite errado',
    randomUUID(),
    database,
    model([{ op: 'finance_plan_create', planKind: 'budget', category: 'Salário', amount: '100' }]),
  );
  assert.equal(invalid.status, 'failed');
  assert.equal((await financePlan({}, database)).items.length, 2);
});

for (const [count, expected] of [
  [0, /lista vazia \(0 ações\)/],
  [11, /11 ações; o limite é 10/],
] as const)
  test(`lista com ${count} ações informa a quantidade e não altera dados`, async () => {
    const before = await loadFinance(database);
    const result = await chat(
      request,
      randomUUID(),
      database,
      model(Array.from({ length: count }, () => commands[0])),
    );
    assert.equal(result.status, 'failed');
    assert.match(result.error!, expected);
    assert.match((await listProviders(database)).providers[0].lastError!, expected);
    assert.deepEqual(await loadFinance(database), before);
  });

test('editar e excluir item do planejamento: exclusão pede confirmação e não toca nos lançamentos', async () => {
  await saveFinancePlanItem({ kind: 'fixed', name: 'Aluguel', amount: '450' }, database);
  await panelAction(
    [{ op: 'finance_create', kind: 'expense', description: 'Pago hoje', amount: '10' }],
    randomUUID(),
    database,
  );
  const entries = (await loadFinance(database)).entries;
  const edited = await chat(
    'Aluguel agora é 500',
    randomUUID(),
    database,
    model([{ op: 'finance_plan_update', planItem: 'Aluguel', amount: '500,00' }]),
  );
  assert.equal(edited.status, 'done', edited.error ?? undefined);
  assert.equal((await financePlan({}, database)).items[0].amountCents, 50000);

  const asked = await chat(
    'Tire o aluguel dos gastos fixos',
    randomUUID(),
    database,
    model([{ op: 'finance_plan_delete', planItem: 'Aluguel', planKind: 'fixed' }]),
  );
  assert.equal(asked.status, 'clarification');
  assert.equal((await financePlan({}, database)).items.length, 1);
  const confirmed = await chat(
    'sim',
    randomUUID(),
    database,
    model([], () => assert.fail('Confirmação não deve chamar IA')),
  );
  assert.equal(confirmed.status, 'done', confirmed.error ?? undefined);
  assert.equal((await financePlan({}, database)).items.length, 0);
  assert.deepEqual((await loadFinance(database)).entries, entries);
});

test('lançamento excluído pode ser listado na lixeira e restaurado pelo chat', async () => {
  await panelAction(
    [{ op: 'finance_create', kind: 'expense', description: 'Pizza', amount: '30' }],
    randomUUID(),
    database,
  );
  const asked = await chat(
    'Exclua o lançamento Pizza',
    randomUUID(),
    database,
    model([{ op: 'finance_delete', entry: 'Pizza' }]),
  );
  assert.equal(asked.status, 'clarification');
  const deleted = await chat('sim', randomUUID(), database, model([]));
  assert.equal(deleted.status, 'done', deleted.error ?? undefined);
  const listed = await chat(
    'O que está na lixeira financeira?',
    randomUUID(),
    database,
    model([{ op: 'finance_list', deleted: true }]),
  );
  assert.equal(listed.status, 'done', listed.error ?? undefined);
  assert.match(listed.reply!, /Pizza/);
  const restored = await chat(
    'Restaure a Pizza',
    randomUUID(),
    database,
    model([{ op: 'finance_restore', entry: 'Pizza' }]),
  );
  assert.equal(restored.status, 'done', restored.error ?? undefined);
  assert.equal(
    (await loadFinance(database)).entries.filter((e) => !e.deletedAt && e.description === 'Pizza')
      .length,
    1,
  );
});

test('modelos de lançamento chegam ao prompt e podem ser usados pelo chat', async () => {
  const created = await chat(
    'Crie o modelo Almoço de 25 reais',
    randomUUID(),
    database,
    model([
      {
        op: 'finance_create_template',
        name: 'Almoço',
        kind: 'expense',
        description: 'Almoço',
        amount: '25,00',
      },
    ]),
  );
  assert.equal(created.status, 'done', created.error ?? undefined);
  const used = await chat(
    'Lance o modelo Almoço',
    randomUUID(),
    database,
    model([{ op: 'finance_use_template', template: 'Almoço' }], (system) =>
      assert.match(system, /Almoço/),
    ),
  );
  assert.equal(used.status, 'done', used.error ?? undefined);
  const entries = (await loadFinance(database)).entries.filter((e) => !e.deletedAt);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountCents, 2500);
});

test('limite acumula os gastos do mês na ordem e o comparativo separa os meses', async () => {
  const category = '00000000-0000-4000-8000-000000000003';
  await saveFinancePlanItem({ kind: 'budget', amount: '500', categoryId: category }, database);
  for (const [date, amount] of [
    ['2026-03-05', '10'],
    ['2026-03-06', '50'],
    ['2026-03-07', '40'],
    ['2026-02-10', '200'],
  ])
    await panelAction(
      [
        {
          op: 'finance_create',
          kind: 'expense',
          description: `g${date}`,
          amount,
          date,
          category: 'Alimentação',
        },
      ],
      randomUUID(),
      database,
    );
  const plan = await financePlan({ month: '2026-03' }, database);
  assert.deepEqual(
    plan.expenseEntries.filter((e) => e.categoryId === category).map((e) => e.amountCents),
    [1000, 5000, 4000],
  );
  assert.equal(plan.real.byCategory.find((c) => c.id === category)?.expense, 10000);
  const compare = await financeCompare({ month: '2026-03', count: '3' }, database);
  assert.deepEqual(
    compare.months.map((m) => [m.month, m.expense]),
    [
      ['2026-01', 0],
      ['2026-02', 20000],
      ['2026-03', 10000],
    ],
  );
  assert.equal(compare.plannedExpense, 50000);
});

test('gasto fixo acumula lançamentos pelo nome ou pela categoria única, sem contar duas vezes', async () => {
  const rent = await saveFinancePlanItem(
    { kind: 'fixed', name: 'Aluguel', amount: '450' },
    database,
  );
  const gym = await saveFinancePlanItem(
    {
      kind: 'fixed',
      name: 'Academia',
      amount: '40',
      categoryId: '00000000-0000-4000-8000-000000000003',
    },
    database,
  );
  const date = new Date().toISOString().slice(0, 10);
  for (const [description, amount, category] of [
    ['Paguei aluguel', '200', 'Sem categoria'],
    ['aluguel resto', '250', 'Sem categoria'],
    ['Mensalidade', '40', 'Alimentação'],
  ])
    await panelAction(
      [{ op: 'finance_create', kind: 'expense', description, amount, category, date }],
      randomUUID(),
      database,
    );
  const plan = await financePlan({ month: date.slice(0, 7) }, database);
  const usage = fixedUsage(plan.items, plan.expenseEntries);
  const of = (id: string) => usage.find((u) => u.item.id === id)!;
  assert.equal(of(rent.id).spent, 45000);
  assert.equal(of(rent.id).percent, 100);
  assert.equal(of(gym.id).spent, 4000);
});

test('nomes compostos reconhecem cada parte e ignoram partes ambíguas', () => {
  const at = '2026-03-01T00:00:00.000Z';
  const item = (name: string) => ({
    id: randomUUID(),
    kind: 'fixed' as const,
    name,
    amountCents: 10000,
    categoryId: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const subs = item('YT + Meli + Spotify'),
    net = item('Internet(Móvel + Fixa)'),
    other = item('Spotify Família');
  const entry = (description: string) => ({
    id: randomUUID(),
    categoryId: randomUUID(),
    date: '2026-03-02',
    description,
    amountCents: 1000,
  });
  const entries = [
    entry('Assinatura YT'),
    entry('Meli+'),
    entry('Pagamento da internet'),
    entry('Spotify'),
  ];
  const usage = fixedUsage([subs, net, other], entries);
  const spent = (x: { id: string }) => usage.find((u) => u.item.id === x.id)!.spent;
  assert.equal(spent(subs), 2000);
  assert.equal(spent(net), 1000);
  assert.equal(spent(other), 0);
});
