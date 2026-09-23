import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, loadState, type Database } from '../src/backend/db';
import { chat, panelAction } from '../src/backend/service';
import { emptyState, execute, type Command, type State, type Task } from '../src/backend/domain';
import { basicInterpret, interpret } from '../src/backend/interpreter';
import { saveProvider } from '../src/backend/llm';
import {
  formatWeekSummary,
  resolveWeek,
  weekStart,
  weekSummary,
  type WeekSummary,
} from '../src/backend/summary';
import { summarySnapshot } from '../src/backend/summary-store';
import type { FinanceCategory, FinanceEntry } from '../src/backend/finance/types';

let db: Database;
before(async () => {
  process.env.LLM_ENCRYPTION_KEY = 'a'.repeat(64);
  db = await createDatabase();
});
after(async () => {
  await db.close();
});

// Quarta-feira, 23/09/2026, 10h na Bahia. A semana é de 21/09 (segunda) a 27/09 (domingo).
const now = new Date('2026-09-23T13:00:00Z');
const task = (id: number, fields: Partial<Task>): Task => ({
  id,
  title: `Tarefa ${id}`,
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
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  ...fields,
});
const category = (id: string, name: string): FinanceCategory => ({
  id,
  name,
  kind: 'both',
  archivedAt: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const food = randomUUID();
const transport = randomUUID();
const salary = randomUUID();
const entry = (
  kind: 'income' | 'expense',
  amountCents: number,
  date: string,
  categoryId: string,
  deleted = false,
): FinanceEntry => ({
  id: randomUUID(),
  kind,
  amountCents,
  date,
  description: `${kind} ${date}`,
  categoryId,
  source: 'panel',
  version: 1,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  deletedAt: deleted ? '2026-09-22T12:00:00.000Z' : null,
});
const finance = {
  categories: [
    category(food, 'Alimentação'),
    category(transport, 'Transporte'),
    category(salary, 'Salário'),
  ],
  entries: [
    entry('income', 300000, '2026-09-21', salary),
    entry('expense', 6000, '2026-09-22', food),
    entry('expense', 4000, '2026-09-27', food),
    entry('expense', 2500, '2026-09-24', transport),
    // Excluído não conta; fora da semana só entra na comparação.
    entry('expense', 99900, '2026-09-23', food, true),
    entry('expense', 10000, '2026-09-15', food),
    entry('expense', 5000, '2026-09-28', food),
  ],
  templates: [],
};
const tasks = [
  // Concluída na segunda às 23h30 da Bahia, que já é terça em UTC: conta nesta semana.
  task(1, {
    status: 'completed',
    completedAt: '2026-09-22T02:30:00.000Z',
    createdAt: '2026-09-21T12:00:00.000Z',
  }),
  // Concluída no domingo anterior às 22h da Bahia (segunda em UTC): fica na semana passada.
  task(2, { status: 'completed', completedAt: '2026-09-21T01:00:00.000Z' }),
  // Concluída e depois descartada: não conta como feita.
  task(3, {
    status: 'completed',
    completedAt: '2026-09-22T12:00:00.000Z',
    trashedAt: '2026-09-22T13:00:00.000Z',
    trashReason: 'discarded',
  }),
  task(4, { dueDate: '2026-09-20', createdAt: '2026-09-22T12:00:00.000Z' }),
  task(5, { dueDate: '2026-09-23', dueTime: '09:00' }),
  task(6, { dueDate: '2026-09-29' }),
  task(7, { dueDate: '2026-10-04', dueTime: '18:00' }),
  task(8, { dueDate: '2026-10-05' }),
  // Na lixeira não aparece como atrasada nem como próxima.
  task(9, { dueDate: '2026-09-10', trashedAt: '2026-09-11T12:00:00.000Z' }),
  // Ocorrência gerada por recorrência não conta como criada.
  task(10, { recurringFrom: 1, createdAt: '2026-09-22T02:30:00.000Z', dueDate: '2026-09-30' }),
];
const state = (): State => ({ ...emptyState(), tasks: structuredClone(tasks), finance });

test('a semana começa na segunda pelo dia local da Bahia, e week aceita data ou deslocamento', () => {
  assert.equal(weekStart('2026-09-21'), '2026-09-21');
  assert.equal(weekStart('2026-09-27'), '2026-09-21');
  assert.equal(weekStart('2026-09-28'), '2026-09-28');
  // Domingo 23h na Bahia já é segunda em UTC; a semana continua a de domingo.
  assert.equal(resolveWeek({}, new Date('2026-09-28T02:00:00Z')), '2026-09-21');
  assert.equal(resolveWeek({ week: '-1' }, now), '2026-09-14');
  assert.equal(resolveWeek({ week: '1' }, now), '2026-09-28');
  assert.equal(resolveWeek({ week: '2026-01-01' }, now), '2025-12-29');
  assert.throws(() => resolveWeek({ week: 'ontem' }, now));
  assert.throws(() => resolveWeek({ week: '2026-02-30' }, now));
  assert.throws(() => resolveWeek({ extra: 1 }, now));
});

test('resumo soma tarefas e finanças da semana e compara com a anterior', () => {
  const s = weekSummary(state(), finance, '2026-09-21', now);
  assert.equal(s.end, '2026-09-27');
  assert.equal(s.current, true);
  assert.deepEqual(
    s.tasks.completedList.map((t) => t.id),
    [1],
  );
  assert.equal(s.tasks.created, 2);
  assert.deepEqual(
    s.tasks.overdueList.map((t) => t.id),
    [4, 5],
  );
  assert.deepEqual(
    s.tasks.nextWeekList.map((t) => t.id),
    [6, 10, 7],
  );
  assert.deepEqual(s.finance.totals, { income: 300000, expense: 12500, result: 287500 });
  assert.deepEqual(s.finance.previous, { income: 0, expense: 10000, result: -10000 });
  assert.equal(s.finance.entries, 4);
  assert.deepEqual(
    s.finance.categories.map((c) => [c.name, c.expense, c.share]),
    [
      ['Alimentação', 10000, 80],
      ['Transporte', 2500, 20],
    ],
  );
  const past = weekSummary(state(), finance, '2026-09-14', now);
  assert.equal(past.current, false);
  assert.deepEqual(
    past.tasks.completedList.map((t) => t.id),
    [2],
  );
  assert.equal(past.finance.totals.expense, 10000);
});

test('resposta do resumo traz os números em texto e linhas de tarefa no formato da conversa', () => {
  const text = formatWeekSummary(weekSummary(state(), finance, '2026-09-21', now));
  assert.match(text, /^Resumo da semana de 21\/09 a 27\/09\/2026 \(semana atual\)\./);
  assert.match(text, /1 concluída\(s\), 2 criada\(s\), 2 atrasada\(s\) agora e 3 com prazo/);
  assert.match(text, /Receitas: R\$\s3\.000,00\. Despesas: R\$\s125,00\./);
  assert.match(text, /Despesas \+25,0% em relação à semana anterior/);
  assert.match(text, /Maiores despesas: Alimentação R\$\s100,00 \(80%\); Transporte/);
  assert.match(text, /^#4 Tarefa 4 — 20\/09\/2026$/m);
  assert.match(text, /^#1 Tarefa 1 — concluída em 21\/09$/m);
  const empty: WeekSummary = weekSummary(
    emptyState(),
    { categories: [], entries: [] },
    '2026-09-21',
    now,
  );
  const quiet = formatWeekSummary(empty);
  assert.match(quiet, /Nenhum lançamento financeiro nesta semana/);
  assert.doesNotMatch(quiet, /Maiores despesas|Atrasadas agora|%/);
});

test('week_summary no executor responde sem alterar nada e exige finanças carregadas', () => {
  const before = state();
  const result = execute(before, [{ op: 'week_summary' }], 'web', now);
  assert.match(result.reply, /Resumo da semana de 21\/09/);
  assert.equal(result.state.settings.revision, before.settings.revision);
  assert.equal(result.state.operations.length, 0);
  const past = execute(before, [{ op: 'week_summary', date: '2026-09-16' }], 'web', now);
  assert.match(past.reply, /de 14\/09 a 20\/09\/2026\./);
  assert.throws(
    () => execute({ ...before, finance: undefined }, [{ op: 'week_summary' }], 'web', now),
    /Dados financeiros indisponíveis/,
  );
});

test('sem IA, “resumo da semana” e “como foi minha semana passada” viram week_summary', () => {
  assert.deepEqual(basicInterpret('Resumo da semana', now), [{ op: 'week_summary' }]);
  assert.deepEqual(basicInterpret('como foi minha semana?', now), [{ op: 'week_summary' }]);
  assert.deepEqual(basicInterpret('Como foi minha semana passada?', now), [
    { op: 'week_summary', date: '2026-09-14' },
  ]);
});

test('com IA, o prompt explica week_summary com as semanas resolvidas e aceita o comando', async () => {
  await saveProvider(
    {
      name: 'IA resumo',
      kind: 'compatible',
      model: 'example-model',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret-summary',
      priority: 1,
      enabled: true,
      dailyRequestLimit: 100,
      dailyTokenLimit: 0,
    },
    db,
  );
  let prompt = '';
  const commands = await interpret(emptyState(), 'como foi minha semana passada?', 'web', now, db, {
    fetch: async (_url, init) => {
      prompt = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ commands: [{ op: 'week_summary', date: '2026-09-15' }] }),
            },
          },
        ],
        usage: { total_tokens: 9 },
      });
    },
  });
  assert.deepEqual(commands, [{ op: 'week_summary', date: '2026-09-15' }]);
  assert.match(prompt, /week_summary\(date\?\)/);
  assert.match(prompt, /semana passada: 2026-09-14 a 2026-09-20/);
  await db.query('DELETE FROM agenda_llm_providers');
});

test('resumo pela conversa usa o banco, não passa pela reescrita e bate com a rota da tela', async () => {
  const act = (c: Command[]) => panelAction(c, randomUUID(), db);
  await act([{ op: 'create_task', title: 'Resumo concluída' }]);
  const created = (await loadState(db)).tasks.find((t) => t.title === 'Resumo concluída')!;
  await act([{ op: 'complete_task', task: `#${created.id}` }]);
  await act([{ op: 'create_task', title: 'Resumo atrasada', dueDate: '2020-01-01' }]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
  await act([
    {
      op: 'finance_create',
      kind: 'expense',
      amount: '12,34',
      description: 'Café do resumo',
      category: 'Alimentação',
      date: today,
    },
  ]);
  const screen = await summarySnapshot({}, db);
  assert.equal(screen.current, true);
  assert.ok(screen.tasks.completedList.some((t) => t.title === 'Resumo concluída'));
  assert.ok(screen.tasks.overdueList.some((t) => t.title === 'Resumo atrasada'));
  assert.equal(screen.finance.totals.expense, 1234);
  assert.deepEqual(
    screen.finance.categories.map((c) => c.name),
    ['Alimentação'],
  );
  let rewrites = 0;
  const result = await chat(
    'resumo da semana',
    randomUUID(),
    db,
    async (): Promise<Command[]> => [{ op: 'week_summary' }],
    async () => {
      rewrites++;
      return 'reescrito';
    },
  );
  assert.equal(result.status, 'done');
  assert.equal(rewrites, 0);
  assert.equal(result.reply, formatWeekSummary(screen));
  const last = await summarySnapshot({ week: '-1' }, db);
  assert.equal(last.finance.totals.expense, 0);
  assert.equal(last.finance.previous.expense, 0);
});
