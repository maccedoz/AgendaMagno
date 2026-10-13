import { z } from 'zod';
import { db, lock, type Database, type Sql } from '../db';
import { DomainError, localDate } from '../domain';
import { prepareFinancePlanItem } from './rules';
import { planSummary } from './plan';
import type {
  FinanceCategory,
  FinanceCompareData,
  FinancePlanData,
  FinancePlanItem,
} from './types';

const monthSchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .default(() => localDate().slice(0, 7)),
  })
  .strict();
// O valor chega como texto brasileiro (“1.234,56”) e vira centavos em parseMoney, igual aos
// lançamentos, para a tela não precisar converter nada.
const saveSchema = z
  .object({
    id: z.string().uuid().optional(),
    kind: z.enum(['income', 'fixed', 'budget']),
    name: z.string().trim().max(100).optional(),
    amount: z.string().max(40),
    categoryId: z.string().uuid().nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

async function items(sql: Sql) {
  return (
    await sql.query<{ data: FinancePlanItem }>(
      "SELECT data FROM agenda_finance_plan ORDER BY data->>'kind', lower(data->>'name'), id",
    )
  ).rows.map((r) => r.data);
}
async function categories(sql: Sql) {
  return (
    await sql.query<{ data: FinanceCategory }>(
      "SELECT data FROM agenda_finance_categories ORDER BY data->>'name'",
    )
  ).rows.map((r) => r.data);
}

export async function financePlan(input: unknown, connection?: Database): Promise<FinancePlanData> {
  const { month } = monthSchema.parse(input);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 12))
    .toISOString()
    .slice(0, 10);
  const database = connection ?? (await db());
  return database.read(async (tx) => {
    // O real vem sempre do mês inteiro, sem os filtros da aba de lançamentos: comparar o plano
    // com um recorte filtrado mostraria uma folga que não existe.
    const byCategory = (
      await tx.query<{ id: string; income: string; expense: string }>(
        `SELECT data->>'categoryId' AS id,
          COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='income'),0) AS income,
          COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='expense'),0) AS expense
         FROM agenda_finance_entries
         WHERE data->>'date' >= $1 AND data->>'date' <= $2 AND data->>'deletedAt' IS NULL
         GROUP BY data->>'categoryId'`,
        [start, end],
      )
    ).rows.map((r) => ({ id: r.id, income: Number(r.income), expense: Number(r.expense) }));
    const income = byCategory.reduce((s, c) => s + c.income, 0);
    const expense = byCategory.reduce((s, c) => s + c.expense, 0);
    if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense))
      throw new DomainError('Total excede o limite de cálculo.');
    const planItems = await items(tx);
    const expenseEntries = (
      await tx.query<FinancePlanData['expenseEntries'][number]>(
        `SELECT data->>'id' AS id, data->>'categoryId' AS "categoryId", data->>'date' AS date,
          data->>'description' AS description, (data->>'amountCents')::bigint::float8 AS "amountCents"
         FROM agenda_finance_entries
         WHERE data->>'date' >= $1 AND data->>'date' <= $2 AND data->>'deletedAt' IS NULL
           AND data->>'kind'='expense'
         ORDER BY data->>'date', data->>'createdAt' LIMIT 2000`,
        [start, end],
      )
    ).rows;
    return {
      month,
      items: planItems,
      expenseEntries,
      categories: await categories(tx),
      real: {
        income,
        expense,
        byCategory: byCategory.map(({ id, expense }) => ({ id, expense })),
      },
    };
  });
}

export async function saveFinancePlanItem(
  input: unknown,
  connection?: Database,
): Promise<FinancePlanItem> {
  const value = saveSchema.parse(input);
  const database = connection ?? (await db());
  const at = new Date().toISOString();
  return database.transaction(async (tx) => {
    await lock(tx);
    const item = prepareFinancePlanItem(value, await items(tx), await categories(tx), at);
    await tx.query(
      'INSERT INTO agenda_finance_plan(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      [item.id, JSON.stringify(item)],
    );
    await tx.query(
      "UPDATE agenda_meta SET data=jsonb_set(data,'{revision}',to_jsonb((data->>'revision')::integer+1)) WHERE id=1",
    );
    return item;
  });
}

export async function deleteFinancePlanItem(input: unknown, connection?: Database) {
  const value = z
    .object({ id: z.string().uuid(), expectedVersion: z.number().int().positive().optional() })
    .strict()
    .parse(input);
  const database = connection ?? (await db());
  return database.transaction(async (tx) => {
    await lock(tx);
    const current = (
      await tx.query<{ data: FinancePlanItem }>(
        'SELECT data FROM agenda_finance_plan WHERE id=$1',
        [value.id],
      )
    ).rows[0]?.data;
    if (!current) throw new DomainError('Item do planejamento não encontrado.', 404);
    if (value.expectedVersion !== undefined && value.expectedVersion !== current.version)
      throw new DomainError('Este item foi alterado. Atualize antes de excluir.', 409);
    await tx.query('DELETE FROM agenda_finance_plan WHERE id=$1', [value.id]);
    await tx.query(
      "UPDATE agenda_meta SET data=jsonb_set(data,'{revision}',to_jsonb((data->>'revision')::integer+1)) WHERE id=1",
    );
    return { ok: true };
  });
}

// Comparativo dos últimos meses (até o informado): o que entrou, o que saiu e onde, mês a mês.
export async function financeCompare(
  input: unknown,
  connection?: Database,
): Promise<FinanceCompareData> {
  const { month, count } = z
    .object({
      month: monthSchema.shape.month,
      count: z.coerce.number().int().min(2).max(12).default(6),
    })
    .strict()
    .parse(input);
  const year = Number(month.slice(0, 4)),
    index = Number(month.slice(5, 7)) - 1;
  const months = Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, index - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
  const database = connection ?? (await db());
  return database.read(async (tx) => {
    const rows = (
      await tx.query<{ month: string; id: string; income: string; expense: string }>(
        `SELECT substr(data->>'date',1,7) AS month, data->>'categoryId' AS id,
          COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='income'),0) AS income,
          COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='expense'),0) AS expense
         FROM agenda_finance_entries
         WHERE data->>'date' >= $1 AND data->>'date' <= $2 AND data->>'deletedAt' IS NULL
         GROUP BY 1, 2`,
        [`${months[0]}-01`, `${month}-31`],
      )
    ).rows;
    const planItems = await items(tx);
    const sum = (kind: FinancePlanItem['kind']) =>
      planItems.filter((x) => x.kind === kind).reduce((s, x) => s + x.amountCents, 0);
    const summary = planSummary(planItems);
    return {
      months: months.map((m) => {
        const own = rows.filter((r) => r.month === m);
        const income = own.reduce((s, r) => s + Number(r.income), 0);
        const expense = own.reduce((s, r) => s + Number(r.expense), 0);
        return {
          month: m,
          income,
          expense,
          result: income - expense,
          byCategory: own
            .filter((r) => Number(r.expense) > 0)
            .map((r) => ({ id: r.id, expense: Number(r.expense) })),
        };
      }),
      categories: (await categories(tx)).map(({ id, name }) => ({ id, name })),
      plannedExpense: summary.plannedExpense,
      plannedIncome: sum('income'),
    };
  });
}
