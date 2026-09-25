import { localDate } from '../domain/format';
import {
  addDays,
  daysBetween,
  graceDate,
  nextPeriod,
  periodEnd,
  periodStart,
  weekday,
} from './dates';
import {
  round,
  type Goal,
  type GoalLog,
  type GoalPeriod,
  type GoalProgress,
  type PerfectDays,
  type PeriodResult,
  type PeriodStatus,
} from './types';

// A ofensiva é sempre recalculada a partir dos registros, nunca guardada como contador: apagar
// um registro errado ou mudar o alvo não deixa número dessincronizado, e nenhum processo
// agendado precisa "matar" a ofensiva à meia-noite.
export const FREEZE_EVERY = 7;
export const MAX_FREEZES = 2;
const RECENT: Record<GoalPeriod, number> = { daily: 7, weekly: 8, monthly: 6 };

export function dayTotals(logs: GoalLog[]) {
  const totals = new Map<string, number>();
  for (const log of logs) totals.set(log.date, round((totals.get(log.date) ?? 0) + log.amount));
  return totals;
}
// Alvo que valia no início do período. Os alvos ficam em ordem de data; um período anterior ao
// primeiro (a semana em que a meta foi criada) usa o primeiro.
export function targetFor(goal: Goal, start: string) {
  let value = goal.targets[0].amount;
  for (const t of goal.targets) if (t.from <= start) value = t.amount;
  return value;
}
export const paused = (goal: Goal, from: string, to: string) =>
  goal.pauses.some((p) => p.from <= to && (p.to ?? '9999-12-31') >= from);
// Regra de contagem que valia no início do período (ver `schedules` em types.ts).
export function scheduleFor(goal: Goal, start: string) {
  let rule: Pick<Goal, 'weekdays' | 'countDays'> = goal.schedules?.[0] ?? goal;
  for (const s of goal.schedules ?? []) if (s.from <= start) rule = s;
  return rule;
}
export const scheduledDay = (goal: Goal, date: string) => {
  const { weekdays } = scheduleFor(goal, date);
  return date >= goal.startDate && (!weekdays || weekdays.includes(weekday(date)));
};
export const countsDays = (goal: Goal, start: string) =>
  goal.kind === 'count' && goal.period !== 'daily' && scheduleFor(goal, start).countDays;
// Metas de vezes semanais ou mensais com countDays contam dias com registro, não registros.
function periodAmount(goal: Goal, totals: Map<string, number>, start: string, end: string) {
  const days = countsDays(goal, start);
  let sum = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const value = totals.get(d) ?? 0;
    sum += days ? (value > 0 ? 1 : 0) : value;
  }
  return round(sum);
}

class Counter {
  streak = 0;
  best = 0;
  freezes = 0;
  lost: number | null = null;
  private run = 0;
  met() {
    this.streak++;
    this.run++;
    if (this.run % FREEZE_EVERY === 0) this.freezes = Math.min(MAX_FREEZES, this.freezes + 1);
    this.best = Math.max(this.best, this.streak);
    this.lost = null;
  }
  // Período perdido: gasta um congelamento se houver. Congelar não soma, e o próximo
  // congelamento exige outros 7 períodos cumpridos.
  miss(): PeriodStatus {
    this.run = 0;
    if (this.freezes > 0) {
      this.freezes--;
      return 'frozen';
    }
    this.lost = this.streak > 0 ? this.streak : null;
    this.streak = 0;
    return 'missed';
  }
}

export function evaluate(
  goal: Goal,
  logs: GoalLog[],
  now = new Date(),
  keep = RECENT[goal.period],
): GoalProgress {
  const today = localDate(now);
  const grace = graceDate(now);
  const totals = dayTotals(logs.filter((l) => l.goalId === goal.id));
  const current = periodStart(goal.period, today);
  const counter = new Counter();
  const recent: PeriodResult[] = [];
  let graceResult: PeriodResult | null = null;
  // Meta que começa no futuro ainda mostra o período atual, sem contar nada.
  const first = periodStart(goal.period, goal.startDate < today ? goal.startDate : today);
  for (let start = first; start <= current; start = nextPeriod(goal.period, start)) {
    const end = periodEnd(goal.period, start);
    const target = targetFor(goal, start);
    const amount = periodAmount(goal, totals, start, end);
    // O período atual e o que terminou ontem (antes das 12h) ainda podem ser cumpridos: não
    // somam enquanto não forem, mas também não derrubam a ofensiva.
    const open = start === current || end === grace;
    const skipped =
      end < goal.startDate ||
      paused(goal, start, end) ||
      (goal.period === 'daily' && !scheduledDay(goal, start));
    let status: PeriodStatus;
    if (amount >= target) {
      counter.met();
      status = 'met';
    } else if (skipped) status = 'skipped';
    else if (open) status = 'open';
    else status = counter.miss();
    const result = { start, end, amount, target, status };
    if (status === 'open' && start !== current) graceResult = result;
    recent.push(result);
    if (recent.length > keep) recent.shift();
  }
  const latest = recent.at(-1)!;
  const remaining = round(Math.max(0, latest.target - latest.amount));
  const daysLeft = daysBetween(today, latest.end) + 1;
  // Semana impossível: faltam mais dias com registro do que dias restantes. Avisar agora em vez
  // de esperar o domingo para a ofensiva cair.
  const byDays = countsDays(goal, latest.start);
  const freeDays = daysLeft - ((totals.get(today) ?? 0) > 0 ? 1 : 0);
  return {
    streak: counter.streak,
    best: counter.best,
    freezes: counter.freezes,
    current: latest,
    grace: graceResult,
    recent,
    lost: counter.lost,
    remaining,
    daysLeft,
    // A primeira semana (ou mês) começa pela metade: conta se for cumprida, mas não é
    // anunciada como perdida no dia em que a meta nasce.
    impossible:
      latest.status === 'open' && byDays && goal.startDate <= latest.start && remaining > freeDays,
  };
}

// Todos os períodos desde o início, para o resumo da semana escolher os que caem nela.
export const goalPeriods = (goal: Goal, logs: GoalLog[], now = new Date()) =>
  evaluate(goal, logs, now, Infinity).recent;

// Ofensiva geral, como o número único do Duolingo: dias seguidos em que todas as metas diárias
// que valiam naquele dia foram cumpridas. Dias sem nenhuma meta diária valendo não contam nem
// quebram.
export function perfectDays(goals: Goal[], logs: GoalLog[], now = new Date()): PerfectDays {
  const daily = goals.filter((g) => !g.archivedAt && g.period === 'daily');
  if (!daily.length) return { streak: 0, best: 0, freezes: 0, today: 'none', goals: 0 };
  const totals = new Map(
    daily.map((g) => [g.id, dayTotals(logs.filter((l) => l.goalId === g.id))] as const),
  );
  const today = localDate(now);
  const grace = graceDate(now);
  const counter = new Counter();
  let status: PerfectDays['today'] = 'none';
  const first = daily.map((g) => g.startDate).sort()[0];
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const due = daily.filter((g) => scheduledDay(g, d) && !paused(g, d, d));
    if (!due.length) continue;
    const met = due.every((g) => (totals.get(g.id)!.get(d) ?? 0) >= targetFor(g, d));
    if (met) counter.met();
    else if (d !== today && d !== grace) counter.miss();
    if (d === today) status = met ? 'met' : 'open';
  }
  return {
    streak: counter.streak,
    best: counter.best,
    freezes: counter.freezes,
    today: status,
    goals: daily.length,
  };
}
