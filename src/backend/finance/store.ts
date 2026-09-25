import { z } from 'zod';
import type { Sql, Database } from '../db';
import { db } from '../db';
import { DomainError, localDate } from '../domain';
import { dateSchema } from '../domain/types';
import type {
  FinanceCategory,
  FinanceData,
  FinanceEntry,
  FinancePlanItem,
  FinanceState,
  FinanceTemplate,
} from './types';
export async function loadFinance(tx: Sql): Promise<FinanceState> {
  // Uma consulta só, pelo mesmo motivo de loadState: cada ida ao Neon custa uma viagem de rede.
  const aggregate = (table: string) =>
    `(SELECT COALESCE(jsonb_agg(data ORDER BY id), '[]'::jsonb) FROM ${table})`;
  return (
    await tx.query<FinanceState>(
      `SELECT ${aggregate('agenda_finance_categories')} AS "categories",
        ${aggregate('agenda_finance_entries')} AS "entries",
        ${aggregate('agenda_finance_templates')} AS "templates",
        ${aggregate('agenda_finance_plan')} AS "plan"`,
    )
  ).rows[0];
}
export async function saveFinance(tx: Sql, before: FinanceState, after: FinanceState) {
  for (const key of ['categories', 'entries', 'templates', 'plan'] as const) {
    const items = after[key];
    if (!items) continue;
    const table = `agenda_finance_${key}`;
    const old = new Map((before[key] ?? []).map((x) => [x.id, JSON.stringify(x)]));
    for (const item of items) {
      const json = JSON.stringify(item);
      if (old.get(item.id) !== json)
        await tx.query(
          `INSERT INTO ${table}(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
          [item.id, json],
        );
      old.delete(item.id);
    }
    for (const id of old.keys()) await tx.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
  }
}
const querySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .default(() => localDate().slice(0, 7)),
    fromDate: dateSchema.optional(),
    toDate: dateSchema.optional(),
    kind: z.enum(['income', 'expense']).optional(),
    category: z.string().uuid().optional(),
    deleted: z.enum(['true', 'false']).default('false'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict();
export async function financeSnapshot(input: unknown, connection?: Database): Promise<FinanceData> {
  const q = querySchema.parse(input);
  const start = q.fromDate ?? `${q.month}-01`;
  const lastDay = (reference: string) =>
    new Date(Date.UTC(Number(reference.slice(0, 4)), Number(reference.slice(5, 7)), 0, 12))
      .toISOString()
      .slice(0, 10);
  // Preencher só “De”, com um dia fora do mês escolhido, deixava o início depois do fim e a
  // tela inteira vazia. Sem “Até”, o período termina no fim do mês de quem começa.
  const end = q.toDate ?? lastDay(q.fromDate ?? q.month);
  if (start > end) throw new DomainError('O início do período deve vir antes do fim.');
  const previousStart = new Date(`${start}T12:00:00Z`);
  previousStart.setUTCDate(1);
  previousStart.setUTCMonth(previousStart.getUTCMonth() - 1);
  const previousEnd = new Date(`${start.slice(0, 7)}-01T12:00:00Z`);
  previousEnd.setUTCDate(0);
  const database = connection ?? (await db());
  // Só leitura: sem a trava da agenda e com as consultas em paralelo, cada uma na própria
  // conexão do pool. Antes eram oito idas ao banco em fila.
  const tx: Sql = database;
  const where = `data->>'date' >= $1 AND data->>'date' <= $2 AND ($3::text IS NULL OR data->>'kind'=$3) AND ($4::text IS NULL OR data->>'categoryId'=$4)`;
  const params = [start, end, q.kind ?? null, q.category ?? null];
  const visible = `${where} AND ${q.deleted === 'true' ? "data->>'deletedAt' IS NOT NULL" : "data->>'deletedAt' IS NULL"}`;
  const active = `${where} AND data->>'deletedAt' IS NULL`;
  const aggregate = async (values: unknown[]) => {
    const r = (
      await tx.query<{ income: string; expense: string }>(
        `SELECT COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='income'),0) AS income, COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='expense'),0) AS expense FROM agenda_finance_entries WHERE ${active}`,
        values,
      )
    ).rows[0];
    const income = Number(r.income),
      expense = Number(r.expense);
    if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense))
      throw new DomainError('Total excede o limite de cálculo.');
    return { income, expense, result: income - expense };
  };
  const [categories, entries, total, totals, previous, categoryRows, daily, templates] =
    await Promise.all([
      tx
        .query<{ data: FinanceCategory }>(
          "SELECT data FROM agenda_finance_categories ORDER BY data->>'name'",
        )
        .then((r) => r.rows.map((row) => row.data)),
      tx
        .query<{ data: FinanceEntry }>(
          `SELECT data FROM agenda_finance_entries WHERE ${visible} ORDER BY data->>'date' DESC, id DESC LIMIT 20 OFFSET $5`,
          [...params, (q.page - 1) * 20],
        )
        .then((r) => r.rows.map((row) => row.data)),
      tx
        .query<{ count: string }>(
          `SELECT count(*) FROM agenda_finance_entries WHERE ${visible}`,
          params,
        )
        .then((r) => Number(r.rows[0].count)),
      aggregate(params),
      aggregate([
        previousStart.toISOString().slice(0, 10),
        previousEnd.toISOString().slice(0, 10),
        q.kind ?? null,
        q.category ?? null,
      ]),
      // Receitas e despesas somam separadamente na mesma categoria: “Outras receitas” e
      // “Alimentação” podem aparecer lado a lado sem que um valor recebido esconda um gasto.
      tx
        .query<{ id: string; income: string; expense: string }>(
          `SELECT data->>'categoryId' AS id, COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='income'),0) AS income, COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='expense'),0) AS expense FROM agenda_finance_entries WHERE ${active} GROUP BY data->>'categoryId' ORDER BY SUM((data->>'amountCents')::bigint) DESC`,
          params,
        )
        .then((r) => r.rows),
      tx
        .query<{ date: string; income: string; expense: string }>(
          `SELECT data->>'date' AS date, COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='income'),0) AS income, COALESCE(SUM((data->>'amountCents')::bigint) FILTER(WHERE data->>'kind'='expense'),0) AS expense FROM agenda_finance_entries WHERE ${active} GROUP BY data->>'date' ORDER BY date`,
          params,
        )
        .then((r) =>
          r.rows.map((row) => ({
            date: row.date,
            income: Number(row.income),
            expense: Number(row.expense),
          })),
        ),
      tx
        .query<{ data: FinanceTemplate }>(
          "SELECT data FROM agenda_finance_templates ORDER BY data->>'name'",
        )
        .then((r) => r.rows.map((row) => row.data)),
    ]);
  const byCategory = categoryRows.map((r) => ({
    id: r.id,
    name: categories.find((c) => c.id === r.id)?.name ?? 'Sem categoria',
    income: Number(r.income),
    expense: Number(r.expense),
  }));
  return {
    categories,
    entries,
    templates,
    total,
    page: q.page,
    totals,
    previous,
    byCategory,
    daily,
  };
}
export async function financeContext(tx: Sql) {
  const categories = (
    await tx.query<{ data: FinanceCategory }>(
      'SELECT data FROM agenda_finance_categories ORDER BY id',
    )
  ).rows.map((r) => r.data);
  const entries = (
    await tx.query<{ data: FinanceEntry }>(
      "SELECT data FROM agenda_finance_entries ORDER BY data->>'updatedAt' DESC,id DESC LIMIT 30",
    )
  ).rows.map((r) => ({
    id: r.data.id,
    kind: r.data.kind,
    amountCents: r.data.amountCents,
    date: r.data.date,
    description: r.data.description.slice(0, 200),
    categoryId: r.data.categoryId,
    deleted: !!r.data.deletedAt,
  }));
  return { categories, entries };
}
