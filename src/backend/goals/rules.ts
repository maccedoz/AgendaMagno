import { randomUUID } from 'node:crypto';
import { Ambiguity, DomainError, type Command, type State } from '../domain/types';
import { localDate, normalize } from '../domain/format';
import { addDays, graceDate, openDates, periodStart } from './dates';
import { evaluate, perfectDays } from './streak';
import { formatAmount, periodNoun, streakLabel } from '../../shared/goals';
import {
  MAX_GOAL_AMOUNT,
  round,
  type Goal,
  type GoalIcon,
  type GoalLog,
  type GoalPeriod,
  type GoalProgress,
  type GoalState,
  goalSchema,
} from './types';

export const isGoal = (c: Command) => c.op.startsWith('goal_');
// Como o resumo da semana soma lançamentos, ele também mostra as metas da semana.
export const needsGoals = (c: Command) => isGoal(c) || c.op === 'week_summary';
export const MAX_GOALS = 50;

export { formatAmount, periodNoun, streakLabel };
const periodPhrase: Record<GoalPeriod, string> = {
  daily: 'hoje',
  weekly: 'nesta semana',
  monthly: 'neste mês',
};
const perPeriod: Record<GoalPeriod, string> = {
  daily: 'por dia',
  weekly: 'por semana',
  monthly: 'por mês',
};

// Unidades que convertem entre si: "bebi 1,5 L" numa meta em ml vira 1500.
const FACTORS: Record<string, [string, number]> = {
  ml: ['volume', 1],
  l: ['volume', 1000],
  litro: ['volume', 1000],
  litros: ['volume', 1000],
  g: ['massa', 1],
  kg: ['massa', 1000],
  m: ['distancia', 1],
  km: ['distancia', 1000],
  min: ['tempo', 1],
  mins: ['tempo', 1],
  minuto: ['tempo', 1],
  minutos: ['tempo', 1],
  h: ['tempo', 60],
  hora: ['tempo', 60],
  horas: ['tempo', 60],
};
export function parseGoalAmount(text: string, unit: string): number {
  const match = text.trim().match(/^(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*([\p{L}]+)?\.?$/u);
  if (!match) throw new DomainError('Quantidade inválida. Use um número, como 500 ou 2,5.');
  // "1.500" é mil e quinhentos em português; "1,5" e "1.5" são um e meio.
  let value = /^\d{1,3}(?:\.\d{3})+$/.test(match[1])
    ? Number(match[1].replaceAll('.', ''))
    : Number(match[1].replace(',', '.'));
  const from = match[2] ? FACTORS[normalize(match[2])] : undefined;
  const to = FACTORS[normalize(unit)];
  if (from && to) {
    if (from[0] !== to[0]) throw new DomainError(`Esta meta é medida em ${unit}.`);
    value = (value * from[1]) / to[1];
  } else if (from && !to && normalize(match[2]!) !== normalize(unit))
    throw new DomainError(`Esta meta é medida em ${unit}.`);
  value = round(value);
  if (!(value > 0) || value > MAX_GOAL_AMOUNT)
    throw new DomainError('A quantidade deve ser maior que zero e até 1.000.000.');
  return value;
}

const ICON_WORDS: [RegExp, GoalIcon][] = [
  [/\bagua\b/, 'water'],
  [/\b(ler|leitura|livro|livros|pagina|paginas)\b/, 'book'],
  [/\b(treino|treinar|academia|musculacao|exercicio|exercicios)\b/, 'dumbbell'],
  [/\b(correr|corrida|caminhar|caminhada|pedalar|bike)\b/, 'run'],
  [/\b(meditar|meditacao|respirar)\b/, 'meditate'],
  [/\b(dormir|sono)\b/, 'sleep'],
  [/\b(comer|fruta|frutas|salada|dieta|refeicao)\b/, 'food'],
];
const guessIcon = (title: string): GoalIcon =>
  ICON_WORDS.find(([pattern]) => pattern.test(normalize(title)))?.[1] ?? 'target';
function defaultQuickAdds(kind: Goal['kind'], unit: string, target: number) {
  if (kind === 'count') return [1];
  if (normalize(unit) === 'ml') return [250, 500];
  // Atalhos inteiros: "+2,5 páginas" não é algo que alguém registre.
  return [...new Set([Math.round(target / 4), Math.round(target / 2)].filter((v) => v > 0))];
}

export function findGoal(goals: GoalState, ref: string | undefined, active = true): Goal {
  const pool = goals.goals.filter((g) => !active || !g.archivedAt);
  const options = () => pool.map((g) => ({ ref: g.id, label: g.title }));
  const byId = ref ? pool.find((g) => g.id === ref) : undefined;
  if (byId) return byId;
  if (ref && goals.goals.some((g) => g.id === ref))
    throw new DomainError('Esta meta está arquivada. Reative-a para registrar.');
  // Sem nenhuma meta, perguntar "qual?" mostraria uma lista vazia.
  if (!pool.length)
    throw new DomainError(
      goals.goals.length
        ? 'Suas metas estão arquivadas. Reative uma na aba Metas.'
        : 'Você ainda não tem metas. Crie uma na aba Metas.',
    );
  if (!ref) {
    if (pool.length === 1) return pool[0];
    throw new Ambiguity('Qual meta? Responda com o número da opção:', 'goal', options());
  }
  const exact = pool.filter((g) => normalize(g.title) === normalize(ref));
  if (exact.length === 1) return exact[0];
  const partial = pool.filter(
    (g) =>
      normalize(g.title).includes(normalize(ref)) || normalize(ref).includes(normalize(g.title)),
  );
  if (partial.length === 1) return partial[0];
  throw new Ambiguity('Qual meta? Responda com o número da opção:', 'goal', options());
}

export function statusLine(goal: Goal, p: GoalProgress) {
  const done = p.current.status === 'met';
  const amount = `${formatAmount(p.current.amount, goal.unit)} de ${formatAmount(p.current.target, goal.unit)} ${periodPhrase[goal.period]}`;
  const streak = `ofensiva de ${streakLabel(p.streak, goal.period)}`;
  const state =
    p.current.status === 'skipped'
      ? 'pausada ou fora dos dias da meta'
      : done
        ? 'cumprida'
        : p.impossible
          ? 'não dá mais para cumprir neste período'
          : `faltam ${formatAmount(p.remaining, goal.unit)}`;
  const grace = p.grace
    ? ` Ontem ficou em ${formatAmount(p.grace.amount, goal.unit)} de ${formatAmount(p.grace.target, goal.unit)}: dá para registrar até as 12h.`
    : '';
  return `${goal.title}: ${amount}, ${state}; ${streak}.${grace}`;
}

export function goalCommand(
  state: State,
  c: Command,
  channel: string,
  now: Date,
  batch: Command[] = [c],
): { reply: string; changed: boolean } {
  const data = state.goals;
  if (!data) throw new DomainError('Metas indisponíveis. Atualize e tente novamente.');
  const at = now.toISOString();
  const today = localDate(now);
  const touch = (goal: Goal) => {
    goal.version++;
    goal.updatedAt = at;
  };
  const checkVersion = (goal: Goal) => {
    if (c.expectedVersion !== undefined && c.expectedVersion !== goal.version)
      throw new DomainError('Esta meta foi alterada. Atualize antes de salvar.', 409);
  };
  const progress = (goal: Goal) => evaluate(goal, data.logs, now);
  let reply: string;
  let changed = true;
  switch (c.op) {
    case 'goal_create': {
      const title = goalTitle(c.title);
      if (data.goals.filter((g) => !g.archivedAt).length >= MAX_GOALS)
        throw new DomainError(`Você pode ter até ${MAX_GOALS} metas ativas.`);
      if (data.goals.some((g) => !g.archivedAt && normalize(g.title) === normalize(title)))
        throw new DomainError('Já existe uma meta com esse nome.');
      const period = c.period ?? 'daily';
      const kind =
        c.goalKind ?? (c.unit && !/^vez(es)?$/.test(normalize(c.unit)) ? 'amount' : 'count');
      const unit = kind === 'count' ? 'vezes' : c.unit?.trim();
      if (!unit) throw new DomainError('Informe a unidade da meta, como ml, páginas ou minutos.');
      if (!c.target)
        throw new Ambiguity(
          `Qual é o alvo ${perPeriod[period]}? Exemplo: ${kind === 'count' ? '6' : `10 ${unit}`}.`,
          'target',
          [],
        );
      const target = parseGoalAmount(c.target, unit);
      const startDate = c.date ?? today;
      if (startDate < today) throw new DomainError('A meta começa hoje ou numa data futura.');
      const goal: Goal = {
        id: randomUUID(),
        title,
        icon: c.goalIcon ?? guessIcon(title),
        kind,
        unit,
        period,
        weekdays:
          period === 'daily' && c.weekdays?.length && new Set(c.weekdays).size < 7
            ? [...new Set(c.weekdays)].sort()
            : null,
        countDays: kind === 'count' && period !== 'daily' ? (c.countDays ?? true) : false,
        schedules: [],
        targets: [{ from: periodStart(period, startDate), amount: target }],
        quickAdds: c.quickAdds?.length
          ? quickAdds(c.quickAdds)
          : defaultQuickAdds(kind, unit, target),
        pauses: [],
        reminderTime: c.reminderTime ?? null,
        startDate,
        archivedAt: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      data.goals.push(goal);
      reply = `Meta criada: ${title}, ${formatAmount(target, unit)} ${perPeriod[period]}. A ofensiva começa no primeiro ${periodNoun[period][0]} cumprido.`;
      break;
    }
    case 'goal_update': {
      const goal = findGoal(data, c.goal, false);
      checkVersion(goal);
      if (c.title !== undefined) {
        const title = goalTitle(c.title);
        if (
          data.goals.some(
            (g) => g.id !== goal.id && !g.archivedAt && normalize(g.title) === normalize(title),
          )
        )
          throw new DomainError('Já existe uma meta com esse nome.');
        goal.title = title;
      }
      if (c.goalIcon) goal.icon = c.goalIcon;
      if (c.quickAdds) goal.quickAdds = quickAdds(c.quickAdds);
      if (c.reminderTime !== undefined) goal.reminderTime = c.reminderTime;
      const weekdays =
        c.weekdays !== undefined && goal.period === 'daily'
          ? c.weekdays.length && new Set(c.weekdays).size < 7
            ? [...new Set(c.weekdays)].sort()
            : null
          : goal.weekdays;
      const countDays =
        c.countDays !== undefined && goal.kind === 'count' && goal.period !== 'daily'
          ? c.countDays
          : goal.countDays;
      if (
        JSON.stringify(weekdays) !== JSON.stringify(goal.weekdays) ||
        countDays !== goal.countDays
      ) {
        // Como o alvo, a regra nova vale a partir do período atual: tirar o fim de semana de uma
        // meta não transforma em "perdidos" (nem em "não contou") os fins de semana passados.
        const from = periodStart(goal.period, today);
        if (!goal.schedules.length)
          goal.schedules.push({
            from: goal.targets[0].from,
            weekdays: goal.weekdays,
            countDays: goal.countDays,
          });
        const last = goal.schedules.at(-1)!;
        if (last.from >= from) Object.assign(last, { weekdays, countDays });
        else goal.schedules.push({ from, weekdays, countDays });
        goal.weekdays = weekdays;
        goal.countDays = countDays;
      }
      if (c.target) {
        // O alvo novo vale a partir do período atual; o passado continua julgado pelo antigo.
        const amount = parseGoalAmount(c.target, goal.unit);
        const from = periodStart(goal.period, today);
        const last = goal.targets.at(-1)!;
        if (last.from >= from) last.amount = amount;
        else if (last.amount !== amount) goal.targets.push({ from, amount });
      }
      touch(goal);
      reply = `Meta ${goal.title} atualizada: ${formatAmount(goal.targets.at(-1)!.amount, goal.unit)} ${perPeriod[goal.period]}.`;
      break;
    }
    case 'goal_archive':
    case 'goal_restore': {
      const goal = findGoal(data, c.goal, false);
      checkVersion(goal);
      if (c.op === 'goal_restore' && goal.archivedAt) {
        if (data.goals.some((g) => !g.archivedAt && normalize(g.title) === normalize(goal.title)))
          throw new DomainError('Já existe uma meta ativa com esse nome.');
        if (data.goals.filter((g) => !g.archivedAt).length >= MAX_GOALS)
          throw new DomainError(`Você pode ter até ${MAX_GOALS} metas ativas.`);
      }
      goal.archivedAt = c.op === 'goal_archive' ? at : null;
      touch(goal);
      reply = `Meta ${goal.title} ${goal.archivedAt ? 'arquivada. O histórico continua guardado' : 'reativada'}.`;
      break;
    }
    case 'goal_pause': {
      const goal = findGoal(data, c.goal);
      checkVersion(goal);
      const first = openDates(now)[0];
      const from = c.fromDate ?? today;
      const to = c.toDate ?? null;
      if (from < first)
        throw new DomainError('A pausa começa hoje ou depois: dias já fechados não mudam.');
      if (to && to < from) throw new DomainError('O fim da pausa deve vir depois do início.');
      if (goal.pauses.some((p) => p.from <= (to ?? '9999-12-31') && (p.to ?? '9999-12-31') >= from))
        throw new DomainError('A meta já tem uma pausa nesse período.');
      if (goal.pauses.length >= 200) throw new DomainError('Limite de 200 pausas nesta meta.');
      goal.pauses.push({ from, to });
      goal.pauses.sort((a, b) => a.from.localeCompare(b.from));
      touch(goal);
      reply = `Meta ${goal.title} pausada ${to ? `de ${br(from)} a ${br(to)}` : `a partir de ${br(from)}, até você retomar`}. A ofensiva fica guardada.`;
      break;
    }
    case 'goal_resume': {
      const goal = findGoal(data, c.goal);
      checkVersion(goal);
      const pause = goal.pauses.find((p) => (p.to ?? '9999-12-31') >= today);
      if (!pause) {
        changed = false;
        reply = `Meta ${goal.title} já está valendo.`;
        break;
      }
      if (pause.from >= today) goal.pauses = goal.pauses.filter((p) => p !== pause);
      else pause.to = addDays(today, -1);
      touch(goal);
      reply = `Meta ${goal.title} retomada: vale de novo a partir de hoje.`;
      break;
    }
    case 'goal_delete': {
      const goal = findGoal(data, c.goal, false);
      checkVersion(goal);
      if (!c.confirmed) {
        const waiting = batch.filter((x) => x.op === 'goal_delete' && !x.confirmed).length;
        throw new Ambiguity(
          waiting > 1
            ? `Excluir estas ${waiting} metas e todos os registros delas? Não dá para desfazer.`
            : `Excluir a meta ${goal.title} e todos os registros dela? Não dá para desfazer. Para só parar de acompanhar, arquive.`,
          'confirmed',
          [
            { ref: 'true', label: 'Sim, excluir', keywords: ['sim', 'excluir'] },
            { ref: 'false', label: 'Cancelar', keywords: ['nao', 'cancelar'] },
          ],
        );
      }
      data.goals = data.goals.filter((g) => g.id !== goal.id);
      data.logs = data.logs.filter((l) => l.goalId !== goal.id);
      reply = `Meta ${goal.title} excluída com os registros.`;
      break;
    }
    case 'goal_log': {
      const goal = findGoal(data, c.goal);
      const date = c.date ?? today;
      if (!openDates(now).includes(date))
        throw new DomainError(
          graceDate(now)
            ? 'Só dá para registrar hoje ou ontem (até as 12h).'
            : 'Só dá para registrar hoje: o dia de ontem fechou às 12h.',
        );
      if (date < goal.startDate)
        throw new DomainError(`A meta ${goal.title} começa em ${br(goal.startDate)}.`);
      if (!c.amount && goal.kind === 'amount')
        throw new Ambiguity(
          `Quanto em ${goal.title}? Exemplo: ${formatAmount(goal.quickAdds[0] ?? 1, goal.unit)}.`,
          'amount',
          [],
        );
      const amount = c.amount ? parseGoalAmount(c.amount, goal.unit) : 1;
      if (data.logs.filter((l) => l.goalId === goal.id && l.date === date).length >= 200)
        throw new DomainError('Limite de 200 registros por dia nesta meta.');
      const log: GoalLog = {
        id: randomUUID(),
        goalId: goal.id,
        date,
        amount,
        source: channel === 'web' ? 'web' : 'panel',
        createdAt: at,
      };
      data.logs.push(log);
      const p = progress(goal);
      const period = p.recent.find((r) => r.start <= date && date <= r.end) ?? p.current;
      const met = period.amount >= period.target;
      reply = `${goal.title}: +${formatAmount(amount, goal.unit)}${date === today ? '' : ' ontem'}. ${formatAmount(period.amount, goal.unit)} de ${formatAmount(period.target, goal.unit)}${date === today ? ` ${periodPhrase[goal.period]}` : ''}. ${
        met
          ? `Meta cumprida! Ofensiva de ${streakLabel(p.streak, goal.period)}.`
          : `Faltam ${formatAmount(round(period.target - period.amount), goal.unit)}.`
      }`;
      break;
    }
    case 'goal_delete_log': {
      const log = data.logs.find((l) => l.id === c.entry);
      if (!log) throw new DomainError('Registro não encontrado.', 404);
      if (!openDates(now).includes(log.date))
        throw new DomainError('Esse dia já fechou: registros antigos não mudam.');
      const goal = data.goals.find((g) => g.id === log.goalId)!;
      data.logs = data.logs.filter((l) => l.id !== log.id);
      reply = `Registro de ${formatAmount(log.amount, goal.unit)} removido de ${goal.title}.`;
      break;
    }
    case 'goal_status': {
      changed = false;
      const active = data.goals.filter((g) => !g.archivedAt);
      if (!active.length) {
        reply =
          'Você ainda não tem metas. Crie uma na aba Metas ou peça, por exemplo: “quero beber 2,5 L de água por dia”.';
        break;
      }
      const goals = c.goal ? [findGoal(data, c.goal)] : active;
      const lines = goals.map((g) => statusLine(g, progress(g)));
      if (!c.goal) {
        const perfect = perfectDays(data.goals, data.logs, now);
        if (perfect.goals)
          lines.push(
            `Dias perfeitos (todas as metas diárias cumpridas): ${streakLabel(perfect.streak, 'daily')} seguidos${perfect.today === 'met' ? ', hoje já está garantido' : perfect.today === 'open' ? ', hoje ainda falta' : ''}.`,
          );
      }
      reply = lines.join('\n');
      break;
    }
    default:
      throw new DomainError('Operação de meta inválida.');
  }
  // O que o chat e o painel gravam precisa caber no mesmo schema do backup: senão um arquivo
  // exportado hoje seria recusado na restauração.
  if (changed)
    for (const goal of data.goals)
      if (goal.updatedAt === at && !goalSchema.safeParse(goal).success)
        throw new DomainError('A meta ficou com dados fora dos limites. Revise os campos.');
  // Registros não entram no histórico de atividade: eles mesmos são o histórico da meta, e um
  // copo de água por linha soterraria o resto.
  if (changed && c.op !== 'goal_log' && c.op !== 'goal_delete_log')
    state.history.push({ id: randomUUID(), taskId: 0, action: reply, source: channel, at });
  return { reply, changed };
}
function goalTitle(value: string | undefined) {
  const title = value?.trim();
  if (!title) throw new DomainError('Informe o nome da meta, como Beber água.');
  if (title.length > 100) throw new DomainError('O nome da meta pode ter até 100 caracteres.');
  return title;
}
// Atalhos arredondados ao centésimo, sem zero nem repetidos.
const quickAdds = (values: number[]) => [...new Set(values.map(round).filter((v) => v > 0))];
const br = (date: string) => date.split('-').reverse().join('/');
