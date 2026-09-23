import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, loadState, type Database } from '../src/backend/db';
import { panelAction, chat, startChat, snapshot } from '../src/backend/service';
import { exportBackup, importBackup } from '../src/backend/backup';
import { parseMoney } from '../src/backend/finance/rules';
import { financeSnapshot, loadFinance } from '../src/backend/finance/store';
import { execute, pendingAnswer, type Command } from '../src/backend/domain';
import { featureMigration } from '../src/backend/schema';
import { budgetState, planSummary } from '../src/backend/finance/plan';
import {
  deleteFinancePlanItem,
  financePlan,
  saveFinancePlanItem,
} from '../src/backend/finance/plan-store';
import type { FinancePlanItem } from '../src/backend/finance/types';
let db: Database;
before(async () => {
  db = await createDatabase();
});
after(async () => {
  await db.close();
});
const act = (c: Command[], id = randomUUID()) => panelAction(c, id, db);

test('valores brasileiros são centavos inteiros e rejeitam precisão, sinal e limites inválidos', () => {
  for (const [text, cents] of [
    ['1.234,56', 123456],
    ['42,9', 4290],
    ['R$ 3.000,00', 300000],
    ['0,01', 1],
  ] as const)
    assert.equal(parseMoney(text), cents);
  for (const text of ['0', '-1', '1,234', '1.23', '1e3', 'NaN', '1.000.000.000,00', '1,2,3'])
    assert.throws(() => parseMoney(text));
});
test('lançamentos persistem, deduplicam e os totais, categorias e dias fecham', async () => {
  await act([
    {
      op: 'finance_create',
      kind: 'income',
      amount: '3.000,00',
      description: 'Salário teste',
      category: 'Salário',
      date: '2026-09-23',
    },
  ]);
  const id = randomUUID();
  const command: Command[] = [
    {
      op: 'finance_create',
      kind: 'expense',
      amount: '42,90',
      description: 'Almoço teste',
      category: 'Alimentação',
      date: '2026-09-23',
    },
  ];
  await act(command, id);
  await act(command, id);
  const data = await financeSnapshot({ month: '2026-09' }, db);
  assert.equal(data.total, 2);
  assert.deepEqual(data.totals, { income: 300000, expense: 4290, result: 295710 });
  assert.equal(
    data.byCategory.reduce((s, c) => s + c.expense, 0),
    4290,
  );
  assert.equal(
    data.byCategory.reduce((s, c) => s + c.income, 0),
    300000,
  );
  // Receita e despesa da mesma categoria não se misturam na soma por categoria.
  assert.deepEqual(
    data.byCategory.map((c) => [c.name, c.income, c.expense]).sort(),
    [
      ['Alimentação', 0, 4290],
      ['Salário', 300000, 0],
    ].sort(),
  );
  assert.equal(data.daily[0].expense, 4290);
  assert.ok(!((await snapshot(db)) as Record<string, unknown>).finance);
  await assert.rejects(
    act([
      {
        op: 'finance_create',
        kind: 'expense',
        amount: '10',
        description: 'Data errada',
        date: '2026-02-30',
      },
    ]),
  );
});
test('edição concorrente, lixeira, restauração e categorias arquivadas', async () => {
  let expense = (await loadFinance(db)).entries.find((e) => e.kind === 'expense')!;
  await assert.rejects(
    act([{ op: 'finance_update', entry: expense.id, expectedVersion: 99, amount: '1' }]),
    /alterado/,
  );
  await act([{ op: 'finance_create_category', name: 'Besteiras', categoryKind: 'expense' }]);
  const category = (await loadFinance(db)).categories.find((c) => c.name === 'Besteiras')!;
  await act([
    {
      op: 'finance_update',
      entry: expense.id,
      expectedVersion: expense.version,
      category: category.id,
    },
  ]);
  expense = (await loadFinance(db)).entries.find((e) => e.id === expense.id)!;
  await act([
    { op: 'finance_archive_category', category: category.id, expectedVersion: category.version },
  ]);
  await assert.rejects(
    act([
      {
        op: 'finance_create',
        kind: 'expense',
        amount: '20',
        description: 'Não criar',
        category: category.id,
      },
    ]),
    /ativa/,
  );
  const filtered = await financeSnapshot({ month: '2026-09', category: category.id }, db);
  assert.equal(filtered.totals.expense, 4290);
  await act([
    { op: 'finance_delete', entry: expense.id, expectedVersion: expense.version, confirmed: true },
  ]);
  assert.equal((await financeSnapshot({ month: '2026-09' }, db)).totals.expense, 0);
  assert.equal((await financeSnapshot({ month: '2026-09', deleted: 'true' }, db)).total, 1);
  expense = (await loadFinance(db)).entries.find((e) => e.id === expense.id)!;
  await act([{ op: 'finance_restore', entry: expense.id, expectedVersion: expense.version }]);
  assert.equal((await financeSnapshot({ month: '2026-09' }, db)).totals.result, 295710);
  await assert.rejects(act([{ op: 'undo' }]), /Financeiro/);
});
test('pedidos mistos são atômicos e esclarecimento retoma valor sem duplicar tarefa', async () => {
  const before = await loadState(db, true);
  const result = execute(
    before,
    [
      { op: 'create_task', title: 'Misto' },
      { op: 'finance_create', kind: 'expense', description: 'Mercado' },
    ],
    'web',
  );
  assert.equal(result.clarification, true);
  assert.equal(result.state.tasks.length, before.tasks.length);
  assert.deepEqual(result.state.finance, before.finance);
  const answer = pendingAnswer(result.state, '42,90', 'web', new Date())!;
  assert.equal(answer[1].amount, '42,90');
  const done = execute(result.state, answer, 'web');
  assert.equal(done.state.tasks.length, before.tasks.length + 1);
  assert.equal(done.state.finance!.entries.length, before.finance!.entries.length + 1);
  const count = (await loadState(db)).tasks.length;
  await assert.rejects(
    act([
      { op: 'create_task', title: 'Reverter' },
      { op: 'finance_create', kind: 'expense', amount: '1,234', description: 'Inválido' },
    ]),
  );
  assert.equal((await loadState(db)).tasks.length, count);
});
test('chat financeiro não reescreve valores e reenvio após falha preserva requestId', async () => {
  let rewrites = 0;
  const rewrite = async () => {
    rewrites++;
    return null;
  };
  const id = randomUUID();
  const failed = await chat(
    'Registrar despesa',
    id,
    db,
    async () => {
      throw new Error('Falha simulada');
    },
    rewrite,
  );
  assert.equal(failed.status, 'failed');
  const interpreter = async (): Promise<Command[]> => [
    {
      op: 'finance_create',
      kind: 'expense',
      amount: '10,01',
      description: 'Ônibus',
      category: 'Transporte',
      date: '2026-10-01',
    },
  ];
  const success = await chat('Registrar despesa', id, db, interpreter, rewrite);
  assert.equal(success.status, 'done');
  assert.match(success.reply!, /10,01/);
  assert.equal(rewrites, 0);
  await chat('Registrar despesa', id, db, interpreter, rewrite);
  assert.equal((await financeSnapshot({ month: '2026-10' }, db)).total, 1);
});
test('exclusão pela conversa pede confirmação e aceita cancelar', async () => {
  const state = await loadState(db, true);
  const entry = state.finance!.entries[0];
  const result = execute(state, [{ op: 'finance_delete', entry: entry.id }], 'web');
  assert.equal(result.clarification, true);
  assert.equal(result.state.finance!.entries[0].deletedAt, null);
  const confirmed = pendingAnswer(result.state, 'sim', 'web', new Date())!;
  assert.equal(confirmed[0].confirmed, true);
  assert.ok(execute(result.state, confirmed, 'web').state.finance!.entries[0].deletedAt);
  assert.equal(pendingAnswer(result.state, 'cancelar', 'web', new Date())![0].op, 'clarify');
});
test('backup v2, importação v1 preservando finanças, validação e invalidação de interpretação', async () => {
  const backup = await exportBackup(db);
  assert.equal(backup.version, 2);
  assert.ok(backup.finance);
  const old = {
    format: backup.format,
    version: 1,
    createdAt: backup.createdAt,
    groups: backup.groups,
    tasks: backup.tasks,
    retentionDays: backup.retentionDays,
  };
  const finance = await loadFinance(db);
  await importBackup(old, (await loadState(db)).settings.revision, db);
  assert.deepEqual(await loadFinance(db), finance);
  const invalid = structuredClone(backup);
  invalid.finance!.entries[0].categoryId = randomUUID();
  await assert.rejects(
    importBackup(invalid, (await loadState(db)).settings.revision, db),
    /Categoria/,
  );
  assert.deepEqual(await loadFinance(db), finance);
  const duplicate = structuredClone(backup);
  duplicate.finance!.entries.push(duplicate.finance!.entries[0]);
  await assert.rejects(
    importBackup(duplicate, (await loadState(db)).settings.revision, db),
    /duplicados/,
  );
  const started = await startChat('Em andamento', randomUUID(), db, async () => [
    { op: 'finance_create', kind: 'income', amount: '10', description: 'Não executar' },
  ]);
  await importBackup(backup, (await loadState(db)).settings.revision, db);
  assert.equal((await started.run!()).status, 'failed');
  assert.deepEqual(await loadFinance(db), finance);
});
test('migração financeira é idempotente e paginação mantém agregados globais', async () => {
  const before = await loadFinance(db);
  for (const statement of featureMigration.split(';').filter((s) => s.trim()))
    await db.query(statement);
  assert.deepEqual(await loadFinance(db), before);
  await act(
    Array.from({ length: 25 }, (_, i) => ({
      op: 'finance_create',
      kind: 'expense',
      amount: '0,01',
      description: `Centavo ${i}`,
      date: '2026-11-01',
    })),
  );
  const first = await financeSnapshot({ month: '2026-11' }, db),
    second = await financeSnapshot({ month: '2026-11', page: 2 }, db);
  assert.equal(first.entries.length, 20);
  assert.equal(second.entries.length, 5);
  assert.equal(first.totals.expense, 25);
  assert.deepEqual(first.totals, second.totals);
});
test('modelos guardam o que se repete, viram lançamento e não aceitam nome repetido', async () => {
  await act([
    {
      op: 'finance_create_template',
      name: 'Aluguel',
      kind: 'expense',
      amount: '1.200,00',
      description: 'Aluguel do mês',
      category: 'Moradia',
    },
  ]);
  const saved = (await loadFinance(db)).templates.find((t) => t.name === 'Aluguel')!;
  assert.equal(saved.amountCents, 120000);
  assert.equal(saved.kind, 'expense');
  await assert.rejects(
    act([
      {
        op: 'finance_create_template',
        name: 'aluguel',
        kind: 'expense',
        amount: '10',
        description: 'Outro',
        category: 'Moradia',
      },
    ]),
    /Já existe um modelo/,
  );
  await assert.rejects(
    act([{ op: 'finance_update_template', template: saved.id, expectedVersion: 99, amount: '1' }]),
    /alterado/,
  );
  // O modelo só preenche o formulário: lançar duas vezes no mesmo mês é permitido e o modelo
  // continua existindo depois.
  await act([
    {
      op: 'finance_create',
      kind: saved.kind,
      amount: '1.200,00',
      description: saved.description,
      category: saved.categoryId,
      date: '2026-12-05',
    },
  ]);
  const month = await financeSnapshot({ month: '2026-12' }, db);
  assert.equal(month.totals.expense, 120000);
  assert.equal(month.templates.length, 1);
  await act([
    {
      op: 'finance_update_template',
      template: 'Aluguel',
      expectedVersion: saved.version,
      amount: '1.300,00',
    },
  ]);
  assert.equal((await loadFinance(db)).templates[0].amountCents, 130000);
  await act([{ op: 'finance_delete_template', template: 'Aluguel' }]);
  assert.deepEqual((await loadFinance(db)).templates, []);
  assert.equal((await financeSnapshot({ month: '2026-12' }, db)).totals.expense, 120000);
});
test('categoria pedida na conversa sem tipo vira categoria de despesa', async () => {
  const result = await act([{ op: 'finance_create_category', name: 'Besteiras da conversa' }]);
  assert.match(result.reply!, /criada para despesas/);
  const created = (await loadFinance(db)).categories.find(
    (c) => c.name === 'Besteiras da conversa',
  )!;
  assert.equal(created.kind, 'expense');
  await act([
    {
      op: 'finance_create',
      kind: 'expense',
      amount: '80',
      description: 'Besteira',
      category: 'besteiras da conversa',
      date: '2026-12-06',
    },
  ]);
  const month = await financeSnapshot({ month: '2026-12' }, db);
  assert.equal(month.byCategory.find((c) => c.id === created.id)?.expense, 8000);
});
test('tabela financeira ausente vira aviso de migração na conversa, não “não foi possível”', async () => {
  const fresh = await createDatabase();
  await fresh.query('DROP TABLE agenda_finance_templates');
  const result = await chat(
    'Gastei 2,50 no RU',
    randomUUID(),
    fresh,
    async () => [
      {
        op: 'finance_create',
        kind: 'expense',
        amount: '2,50',
        description: 'RU',
        category: 'Alimentação',
      },
    ],
    async () => null,
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /db:migrate/);
  await fresh.close();
});
test('operação de categoria sem referência não atinge a “Sem categoria” por engano', async () => {
  const fresh = await createDatabase();
  await assert.rejects(
    panelAction([{ op: 'finance_archive_category' }], randomUUID(), fresh),
    /Informe qual categoria/,
  );
  const semCategoria = (await loadFinance(fresh)).categories.find(
    (c) => c.name === 'Sem categoria',
  )!;
  assert.equal(semCategoria.archivedAt, null);
  const restored = await panelAction(
    [
      { op: 'finance_archive_category', category: semCategoria.id, expectedVersion: 1 },
      { op: 'finance_restore_category', category: semCategoria.id, expectedVersion: 2 },
    ],
    randomUUID(),
    fresh,
  );
  assert.match(restored.reply!, /reativada/);
  await fresh.close();
});
test('filtrar só por “De”, fora do mês escolhido, não esvazia a tela', async () => {
  const fresh = await createDatabase();
  await panelAction(
    [
      {
        op: 'finance_create',
        kind: 'expense',
        amount: '10',
        description: 'Fora do mês',
        category: 'Transporte',
        date: '2027-11-20',
      },
    ],
    randomUUID(),
    fresh,
  );
  const data = await financeSnapshot({ month: '2027-09', fromDate: '2027-11-01' }, fresh);
  assert.equal(data.totals.expense, 1000);
  assert.equal(data.total, 1);
  await assert.rejects(
    financeSnapshot({ month: '2027-09', fromDate: '2027-11-01', toDate: '2027-10-01' }, fresh),
    /antes do fim/,
  );
  await fresh.close();
});
test('resposta longa demais a uma pergunta de valor explica o que fazer', async () => {
  const state = await loadState(db, true);
  const asked = execute(
    state,
    [{ op: 'finance_create', kind: 'expense', description: 'Mercado' }],
    'web',
  );
  assert.equal(asked.clarification, true);
  assert.throws(
    () =>
      pendingAnswer(
        asked.state,
        'foi algo perto de quarenta e dois reais e noventa centavos hoje',
        'web',
        new Date(),
      ),
    /só com o valor/,
  );
});
test('excluir vários lançamentos pede uma confirmação só', async () => {
  let state = await loadState(db, true);
  for (const description of ['Pão', 'Café'])
    state = execute(
      state,
      [
        {
          op: 'finance_create',
          kind: 'expense',
          amount: '5,00',
          description,
          category: 'Alimentação',
        },
      ],
      'web',
    ).state;
  const result = execute(
    state,
    [
      { op: 'finance_delete', entry: 'Pão' },
      { op: 'finance_delete', entry: 'Café' },
    ],
    'web',
  );
  assert.equal(result.clarification, true);
  assert.match(result.reply, /Excluir estes 2 lançamentos\?\n- Pão, R\$\s?5,00\n- Café/);
  const confirmed = pendingAnswer(result.state, 'sim', 'web', new Date())!;
  assert.ok(confirmed.every((c) => c.confirmed));
  const done = execute(result.state, confirmed, 'web');
  assert.equal(done.clarification, false);
  const gone = done.state.finance!.entries.filter((e) => ['Pão', 'Café'].includes(e.description));
  assert.ok(gone.every((e) => e.deletedAt));
});

test('cálculo planejado não desconta duas vezes o fixo e avisa a partir de 80% do limite', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const moradia = randomUUID(),
    comida = randomUUID();
  const item = (
    kind: FinancePlanItem['kind'],
    name: string,
    amountCents: number,
    categoryId: string | null = null,
  ): FinancePlanItem => ({
    id: randomUUID(),
    kind,
    name,
    amountCents,
    categoryId,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const items = [
    item('income', 'Salário', 300000),
    item('fixed', 'Aluguel', 120000, moradia),
    item('fixed', 'Internet', 10000),
    item('budget', '', 150000, moradia),
    item('budget', '', 80000, comida),
  ];
  const summary = planSummary(items, {
    income: 250000,
    expense: 184000,
    byCategory: [
      { id: moradia, expense: 120000 },
      { id: comida, expense: 64000 },
    ],
  });
  assert.equal(summary.income, 300000);
  assert.equal(summary.fixed, 130000);
  assert.equal(summary.leftover, 170000);
  assert.equal(summary.budgets, 230000);
  // Moradia só acrescenta os 300,00 que passam do aluguel; Alimentação entra inteira.
  assert.equal(summary.budgetsBeyondFixed, 110000);
  assert.equal(summary.free, 60000);
  assert.equal(summary.plannedExpense, 240000);
  assert.deepEqual(
    summary.budgetRows.map((r) => [r.percent, r.state]),
    [
      [80, 'warning'],
      [80, 'warning'],
    ],
  );
  assert.equal(budgetState(63999, 80000), 'ok');
  assert.equal(budgetState(64000, 80000), 'warning');
  assert.equal(budgetState(80000, 80000), 'warning');
  assert.equal(budgetState(80001, 80000), 'over');
  assert.equal(planSummary([]).free, 0);
});
test('planejamento fica fora dos totais reais, valida entradas e controla versão', async () => {
  const month = '2027-03';
  const before = await financeSnapshot({ month: '2026-09' }, db);
  const salary = await saveFinancePlanItem(
    { kind: 'income', name: 'Salário', amount: '3.000,00' },
    db,
  );
  assert.equal(salary.amountCents, 300000);
  assert.equal(salary.categoryId, null);
  const moradia = '00000000-0000-4000-8000-000000000005';
  const comida = '00000000-0000-4000-8000-000000000003';
  const rent = await saveFinancePlanItem(
    { kind: 'fixed', name: 'Aluguel', amount: '1.200,00', categoryId: moradia },
    db,
  );
  await saveFinancePlanItem({ kind: 'fixed', name: 'Internet', amount: '100' }, db);
  const food = await saveFinancePlanItem(
    { kind: 'budget', amount: '500,00', categoryId: comida },
    db,
  );
  assert.equal(food.name, '');
  // Nada do plano aparece no resumo real, nem de outro mês.
  assert.deepEqual(await financeSnapshot({ month: '2026-09' }, db), before);
  for (const [input, message] of [
    [{ kind: 'income', name: 'Extra', amount: '1,234' }, /Valor inválido/],
    [{ kind: 'income', name: '', amount: '10' }, /nome da renda/],
    [{ kind: 'fixed', amount: '10' }, /nome do gasto fixo/],
    [{ kind: 'budget', amount: '10' }, /categoria do limite/],
    [
      { kind: 'budget', amount: '10', categoryId: '00000000-0000-4000-8000-000000000001' },
      /categoria de despesa/,
    ],
    [{ kind: 'budget', amount: '10', categoryId: comida }, /já tem um limite/],
    [{ kind: 'fixed', name: 'aluguel', amount: '10' }, /mesmo nome|com esse nome/],
    [{ kind: 'fixed', name: 'Luz', amount: '0,00' }, /entre R\$/],
  ] as const)
    await assert.rejects(saveFinancePlanItem(input, db), message);
  await assert.rejects(
    saveFinancePlanItem({ kind: 'income', name: 'X', amount: '1', extra: true }, db),
    (e: Error) => e.name === 'ZodError',
  );
  const edited = await saveFinancePlanItem(
    {
      id: rent.id,
      kind: 'fixed',
      name: 'Aluguel',
      amount: '1.300,00',
      categoryId: moradia,
      expectedVersion: 1,
    },
    db,
  );
  assert.equal(edited.version, 2);
  await assert.rejects(
    saveFinancePlanItem(
      { id: rent.id, kind: 'fixed', name: 'Aluguel', amount: '1,00', expectedVersion: 1 },
      db,
    ),
    /alterado/,
  );
  await assert.rejects(
    saveFinancePlanItem({ id: rent.id, kind: 'income', name: 'Aluguel', amount: '1,00' }, db),
    /mudar o tipo/,
  );
  await act([
    {
      op: 'finance_create',
      kind: 'expense',
      amount: '450,00',
      description: 'Mercado plano',
      category: 'Alimentação',
      date: `${month}-10`,
    },
    {
      op: 'finance_create',
      kind: 'income',
      amount: '2.800,00',
      description: 'Salário plano',
      category: 'Salário',
      date: `${month}-05`,
    },
    {
      op: 'finance_create',
      kind: 'expense',
      amount: '99,00',
      description: 'Fora do mês',
      category: 'Alimentação',
      date: '2027-04-01',
    },
  ]);
  const plan = await financePlan({ month }, db);
  assert.equal(plan.month, month);
  assert.deepEqual(plan.real.income, 280000);
  assert.deepEqual(plan.real.expense, 45000);
  const summary = planSummary(plan.items, plan.real);
  assert.equal(summary.leftover, 300000 - 140000);
  assert.deepEqual(
    summary.budgetRows.map((r) => [r.spent, r.percent, r.state]),
    [[45000, 90, 'warning']],
  );
  await assert.rejects(deleteFinancePlanItem({ id: food.id, expectedVersion: 9 }, db), /alterado/);
  await deleteFinancePlanItem({ id: food.id, expectedVersion: 1 }, db);
  assert.equal((await financePlan({ month }, db)).items.length, 3);
  await assert.rejects(deleteFinancePlanItem({ id: food.id }, db), /não encontrado/);
});
test('backup leva o planejamento e arquivo sem a lista preserva o atual', async () => {
  const backup = await exportBackup(db);
  const plan = backup.finance!.plan!;
  assert.equal(plan.length, 3);
  const withoutPlan = structuredClone(backup);
  delete withoutPlan.finance!.plan;
  await importBackup(withoutPlan, (await loadState(db)).settings.revision, db);
  assert.equal((await loadFinance(db)).plan!.length, 3);
  const replaced = structuredClone(backup);
  replaced.finance!.plan = plan.filter((x) => x.kind === 'income');
  await importBackup(replaced, (await loadState(db)).settings.revision, db);
  assert.deepEqual(
    (await loadFinance(db)).plan!.map((x) => x.name),
    ['Salário'],
  );
  const broken = structuredClone(backup);
  broken.finance!.plan!.push({
    ...plan.find((x) => x.kind === 'fixed' && x.categoryId)!,
    id: randomUUID(),
    name: 'Outro',
    categoryId: randomUUID(),
  });
  await assert.rejects(
    importBackup(broken, (await loadState(db)).settings.revision, db),
    /planejamento/,
  );
  await importBackup(backup, (await loadState(db)).settings.revision, db);
  assert.equal((await loadFinance(db)).plan!.length, 3);
});
