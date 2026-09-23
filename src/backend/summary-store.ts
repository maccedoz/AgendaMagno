import type { Database } from './db';
import { db, lock } from './db';
import { DomainError, type Group, type Task } from './domain';
import type { FinanceCategory, FinanceEntry } from './finance/types';
import { addDays, resolveWeek, weekSummary } from './summary';

// Separado de summary.ts porque o executor de comandos usa o cálculo puro, e importar o banco
// de lá fecharia um ciclo domain → summary → db → domain.
// Leitura para a tela: só as tabelas necessárias, e dos lançamentos só as duas semanas que
// entram na conta (a escolhida e a anterior, para a comparação).
export async function summarySnapshot(input: unknown, connection?: Database, now = new Date()) {
  const start = resolveWeek(input, now);
  if (start < '2000-01-01' || start > '2999-12-25')
    throw new DomainError('Semana fora do intervalo aceito.');
  const database = connection ?? (await db());
  return database.transaction(async (tx) => {
    await lock(tx);
    const tasks = (
      await tx.query<{ data: Task }>('SELECT data FROM agenda_tasks ORDER BY id')
    ).rows.map((r) => r.data);
    const groups = (
      await tx.query<{ data: Group }>('SELECT data FROM agenda_groups ORDER BY id')
    ).rows.map((r) => r.data);
    const categories = (
      await tx.query<{ data: FinanceCategory }>('SELECT data FROM agenda_finance_categories')
    ).rows.map((r) => r.data);
    const entries = (
      await tx.query<{ data: FinanceEntry }>(
        `SELECT data FROM agenda_finance_entries
         WHERE data->>'date' >= $1 AND data->>'date' <= $2 AND data->>'deletedAt' IS NULL`,
        [addDays(start, -7), addDays(start, 6)],
      )
    ).rows.map((r) => r.data);
    return weekSummary({ tasks, groups }, { categories, entries }, start, now);
  });
}
