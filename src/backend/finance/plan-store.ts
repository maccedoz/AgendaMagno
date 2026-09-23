import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, lock, type Database, type Sql } from '../db';
import { DomainError, localDate, normalize } from '../domain';
import { parseMoney } from './rules';
import type { FinanceCategory, FinancePlanData, FinancePlanItem } from './types';

const MAX_ITEMS = 300;
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
  return database.transaction(async (tx) => {
    await lock(tx);
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
    return {
      month,
      items: await items(tx),
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
  const amountCents = parseMoney(value.amount);
  const database = connection ?? (await db());
  const at = new Date().toISOString();
  return database.transaction(async (tx) => {
    await lock(tx);
    const all = await items(tx);
    const current = value.id ? all.find((x) => x.id === value.id) : undefined;
    if (value.id && !current) throw new DomainError('Item do planejamento não encontrado.', 404);
    if (current && value.expectedVersion !== undefined && value.expectedVersion !== current.version)
      throw new DomainError('Este item foi alterado. Atualize antes de salvar.', 409);
    if (current && current.kind !== value.kind)
      throw new DomainError('Não é possível mudar o tipo de um item do planejamento.');
    if (!current && all.length >= MAX_ITEMS)
      throw new DomainError(`O planejamento aceita até ${MAX_ITEMS} itens.`);
    const others = all.filter((x) => x.id !== current?.id && x.kind === value.kind);
    let name = value.name?.trim() ?? '';
    let categoryId: string | null = null;
    if (value.kind === 'income') {
      if (!name) throw new DomainError('Informe o nome da renda, como Salário.');
    } else {
      if (value.kind === 'fixed' && !name)
        throw new DomainError('Informe o nome do gasto fixo, como Aluguel.');
      if (value.categoryId) {
        const category = (await categories(tx)).find((c) => c.id === value.categoryId);
        if (!category || category.kind === 'income')
          throw new DomainError('Escolha uma categoria de despesa.');
        // Categoria arquivada continua valendo para quem já a usava; só não entra em item novo.
        if (category.archivedAt && category.id !== current?.categoryId)
          throw new DomainError('Escolha uma categoria ativa.');
        categoryId = category.id;
      } else if (value.kind === 'budget') throw new DomainError('Escolha a categoria do limite.');
    }
    if (value.kind === 'budget') {
      name = '';
      if (others.some((x) => x.categoryId === categoryId))
        throw new DomainError('Essa categoria já tem um limite. Edite o existente.');
    } else if (others.some((x) => normalize(x.name) === normalize(name)))
      throw new DomainError('Já existe um item com esse nome.');
    const item: FinancePlanItem = current
      ? { ...current, name, amountCents, categoryId, version: current.version + 1, updatedAt: at }
      : {
          id: randomUUID(),
          kind: value.kind,
          name,
          amountCents,
          categoryId,
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
    await tx.query(
      'INSERT INTO agenda_finance_plan(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      [item.id, JSON.stringify(item)],
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
    return { ok: true };
  });
}
