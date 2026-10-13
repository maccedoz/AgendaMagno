import { DomainError, type Command } from '../domain/types';
import { localDate } from '../domain/format';
import type { FinanceEntry } from './types';

export function monthRange(month: string) {
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 12))
    .toISOString()
    .slice(0, 10);
  return { fromDate: `${month}-01`, toDate: end };
}

// A mesma seleção de mês e intervalo do painel. A comparação sempre usa o mês inteiro
// anterior ao começo do período, mesmo quando o pedido traz só uma data inicial.
export function reportPeriod(command: Command, now: Date) {
  const month = command.month ?? localDate(now).slice(0, 7);
  const fromDate = command.fromDate ?? monthRange(month).fromDate;
  const toDate = command.toDate ?? monthRange(command.fromDate?.slice(0, 7) ?? month).toDate;
  if (fromDate > toDate) throw new DomainError('O início do período deve vir antes do fim.');
  const previousDate = new Date(`${fromDate.slice(0, 7)}-01T12:00:00Z`);
  previousDate.setUTCMonth(previousDate.getUTCMonth() - 1);
  return { fromDate, toDate, previous: monthRange(previousDate.toISOString().slice(0, 7)) };
}

export function entryTotals(entries: FinanceEntry[]) {
  const income = entries
    .filter((x) => x.kind === 'income')
    .reduce((sum, x) => sum + x.amountCents, 0);
  const expense = entries
    .filter((x) => x.kind === 'expense')
    .reduce((sum, x) => sum + x.amountCents, 0);
  if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense))
    throw new DomainError('Total excede o limite de cálculo.');
  return { income, expense, result: income - expense };
}

export function entriesInPeriod(entries: FinanceEntry[], fromDate: string, toDate: string) {
  return entries.filter((x) => !x.deletedAt && x.date >= fromDate && x.date <= toDate);
}

export function groupedTotals(entries: FinanceEntry[], key: 'categoryId' | 'date') {
  const groups = new Map<string, FinanceEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry[key]) ?? [];
    group.push(entry);
    groups.set(entry[key], group);
  }
  return [...groups]
    .map(([id, rows]) => ({ id, ...entryTotals(rows) }))
    .sort((a, b) =>
      key === 'date'
        ? a.id.localeCompare(b.id)
        : b.income + b.expense - a.income - a.expense || a.id.localeCompare(b.id),
    );
}

export function financePage<T>(items: T[], page = 1) {
  return items.slice((page - 1) * 10, page * 10);
}

export function pageHint(total: number, page = 1) {
  return `Página ${page}.${total > page * 10 ? ' Diga “mostrar mais” para continuar.' : ''}`;
}
