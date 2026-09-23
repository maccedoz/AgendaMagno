import { z } from 'zod';
import { dueLabel, isOverdue, localDate } from './domain/format';
import { dateSchema, type Group, type Task } from './domain/types';
import { money } from './finance/rules';
import type { FinanceCategory, FinanceEntry, FinanceTotals } from './finance/types';

export type SummaryTask = {
  id: number;
  title: string;
  group: string | null;
  dueDate: string | null;
  dueTime: string | null;
  completedAt: string | null;
};
export type WeekSummary = {
  start: string;
  end: string;
  nextStart: string;
  nextEnd: string;
  current: boolean;
  tasks: {
    completed: number;
    created: number;
    overdue: number;
    nextWeek: number;
    completedList: SummaryTask[];
    overdueList: SummaryTask[];
    nextWeekList: SummaryTask[];
  };
  finance: {
    totals: FinanceTotals;
    previous: FinanceTotals;
    entries: number;
    categories: { id: string; name: string; expense: number; share: number }[];
  };
};

const LIST_LIMIT = 20;
const TOP_CATEGORIES = 5;
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
// Semana de segunda a domingo, contada no dia local da Bahia. getUTCDay em meio-dia UTC dá o
// dia da semana da própria data, sem o fuso do servidor puxar para o dia anterior.
export function weekStart(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
const weekSchema = z
  .object({
    week: z.union([dateSchema, z.string().regex(/^-?\d{1,3}$/)]).optional(),
  })
  .strict();
// `week` aceita um dia qualquer da semana desejada ou um deslocamento em semanas a partir da
// atual (-1 é a semana passada). Sem ele, vale a semana corrente.
export function resolveWeek(input: unknown, now = new Date()) {
  const { week } = weekSchema.parse(input ?? {});
  const current = weekStart(localDate(now));
  if (!week) return current;
  if (/^-?\d+$/.test(week)) return addDays(current, 7 * Number(week));
  return weekStart(week);
}

// Cálculo puro, compartilhado pela tela e pelo assistente: as duas respostas saem dos mesmos
// números, e a da conversa não passa por modelo nenhum.
export function weekSummary(
  data: { tasks: Task[]; groups: Group[] },
  finance: { categories: FinanceCategory[]; entries: FinanceEntry[] },
  start: string,
  now = new Date(),
): WeekSummary {
  const end = addDays(start, 6);
  const nextStart = addDays(start, 7);
  const nextEnd = addDays(start, 13);
  const inWeek = (date: string | null, from = start, to = end) =>
    Boolean(date && date >= from && date <= to);
  const localDay = (iso: string | null) => (iso ? localDate(new Date(iso)) : null);
  const open = (t: Task) => !t.trashedAt && t.status !== 'completed';
  const item = (t: Task): SummaryTask => ({
    id: t.id,
    title: t.title,
    group: data.groups.find((g) => g.id === t.groupId)?.name ?? null,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    completedAt: t.completedAt,
  });
  const byDue = (a: Task, b: Task) =>
    `${a.dueDate}${a.dueTime ?? ''}`.localeCompare(`${b.dueDate}${b.dueTime ?? ''}`) || a.id - b.id;
  // Concluída e depois descartada não conta: a pessoa desistiu dela, não a terminou.
  const completed = data.tasks
    .filter(
      (t) =>
        t.status === 'completed' &&
        t.trashReason !== 'discarded' &&
        inWeek(localDay(t.completedAt)),
    )
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  // A próxima ocorrência de uma recorrente nasce sozinha ao concluir a anterior; contá-la como
  // criada inflaria a semana com tarefas que ninguém escreveu.
  const created = data.tasks.filter((t) => !t.recurringFrom && inWeek(localDay(t.createdAt)));
  // Atrasadas e próximas são sempre de agora: o estado de uma semana passada não é guardado, e
  // uma lista “atrasada naquela época” mostraria tarefas que já foram resolvidas.
  const overdue = data.tasks.filter((t) => open(t) && isOverdue(t, now)).sort(byDue);
  const nextWeek = data.tasks
    .filter((t) => open(t) && inWeek(t.dueDate, nextStart, nextEnd))
    .sort(byDue);

  const totals = (from: string, to: string) => {
    const entries = finance.entries.filter((e) => !e.deletedAt && inWeek(e.date, from, to));
    const sum = (kind: 'income' | 'expense') =>
      entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountCents, 0);
    const income = sum('income');
    const expense = sum('expense');
    return { entries, totals: { income, expense, result: income - expense } };
  };
  const week = totals(start, end);
  const previous = totals(addDays(start, -7), addDays(start, -1));
  const spent = new Map<string, number>();
  for (const e of week.entries)
    if (e.kind === 'expense')
      spent.set(e.categoryId, (spent.get(e.categoryId) ?? 0) + e.amountCents);
  const categories = [...spent]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CATEGORIES)
    .map(([id, expense]) => ({
      id,
      name: finance.categories.find((c) => c.id === id)?.name ?? 'Sem categoria',
      expense,
      share: week.totals.expense ? Math.round((1000 * expense) / week.totals.expense) / 10 : 0,
    }));
  return {
    start,
    end,
    nextStart,
    nextEnd,
    current: start === weekStart(localDate(now)),
    tasks: {
      completed: completed.length,
      created: created.length,
      overdue: overdue.length,
      nextWeek: nextWeek.length,
      completedList: completed.slice(0, LIST_LIMIT).map(item),
      overdueList: overdue.slice(0, LIST_LIMIT).map(item),
      nextWeekList: nextWeek.slice(0, LIST_LIMIT).map(item),
    },
    finance: {
      totals: week.totals,
      previous: previous.totals,
      entries: week.entries.length,
      categories,
    },
  };
}

const short = (date: string) => date.slice(5).split('-').reverse().join('/');
export const weekLabel = (s: Pick<WeekSummary, 'start' | 'end'>) =>
  `${short(s.start)} a ${short(s.end)}/${s.end.slice(0, 4)}`;
// Variação das despesas contra a semana anterior. Sem gasto na anterior não há base: a
// porcentagem seria infinita, então a frase diz isso em vez de inventar um número.
export function expenseChange(s: WeekSummary) {
  const { expense } = s.finance.totals;
  const before = s.finance.previous.expense;
  if (!before) return expense ? 'sem despesas na semana anterior para comparar' : null;
  const change = (expense / before - 1) * 100;
  if (Math.abs(change) < 0.05) return 'despesas iguais às da semana anterior';
  return `despesas ${change > 0 ? '+' : ''}${change.toFixed(1).replace('.', ',')}% em relação à semana anterior`;
}

// Resposta do assistente. Linhas “#N título — detalhe” viram cartões de tarefa na conversa,
// como nas consultas de tarefas; blocos separados por linha em branco viram seções.
export function formatWeekSummary(s: WeekSummary) {
  const lines = (list: SummaryTask[], total: number, detail: (t: SummaryTask) => string) => {
    const shown = list.slice(0, 5).map((t) => `#${t.id} ${t.title} — ${detail(t)}`);
    return total > shown.length ? [...shown, `E mais ${total - shown.length}.`] : shown;
  };
  const due = (t: SummaryTask) => dueLabel({ dueDate: t.dueDate, dueTime: t.dueTime } as Task);
  const { tasks, finance } = s;
  const blocks = [
    [
      `Resumo da semana de ${weekLabel(s)}${s.current ? ' (semana atual)' : ''}.`,
      `Tarefas: ${tasks.completed} concluída(s), ${tasks.created} criada(s), ${tasks.overdue} atrasada(s) agora e ${tasks.nextWeek} com prazo na semana seguinte.`,
    ],
    [
      finance.entries
        ? `Receitas: ${money(finance.totals.income)}. Despesas: ${money(finance.totals.expense)}. Resultado da semana: ${money(finance.totals.result)}.`
        : 'Nenhum lançamento financeiro nesta semana.',
      `Semana anterior: receitas ${money(finance.previous.income)}, despesas ${money(finance.previous.expense)}.${expenseChange(s) ? ` ${expenseChange(s)![0].toUpperCase()}${expenseChange(s)!.slice(1)}.` : ''}`,
      ...(finance.categories.length
        ? [
            `Maiores despesas: ${finance.categories
              .map((c) => `${c.name} ${money(c.expense)} (${String(c.share).replace('.', ',')}%)`)
              .join('; ')}.`,
          ]
        : []),
    ],
  ];
  if (tasks.completed)
    blocks.push([
      'Concluídas na semana:',
      ...lines(tasks.completedList, tasks.completed, (t) =>
        t.completedAt ? `concluída em ${short(localDate(new Date(t.completedAt)))}` : 'concluída',
      ),
    ]);
  if (tasks.overdue)
    blocks.push(['Atrasadas agora:', ...lines(tasks.overdueList, tasks.overdue, due)]);
  if (tasks.nextWeek)
    blocks.push(['Prazo na semana seguinte:', ...lines(tasks.nextWeekList, tasks.nextWeek, due)]);
  return blocks.map((b) => b.join('\n')).join('\n\n');
}
