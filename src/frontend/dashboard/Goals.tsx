'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Apple,
  BookOpen,
  Brain,
  Droplet,
  Dumbbell,
  Flame,
  Footprints,
  Heart,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Snowflake,
  Star,
  Target,
  Trophy,
  X,
} from 'lucide-react';
import type { Command } from '@/backend/domain';
import type { GoalIcon, GoalsData, GoalView, PeriodResult } from '@/backend/goals/types';
import { formatAmount, periodNoun, streakLabel } from '@/shared/goals';
import { api } from './api';
import { GoalDialog } from './GoalDialog';

export const goalIcons: Record<GoalIcon, (size: number) => ReactNode> = {
  target: (size) => <Target size={size} />,
  water: (size) => <Droplet size={size} />,
  book: (size) => <BookOpen size={size} />,
  dumbbell: (size) => <Dumbbell size={size} />,
  run: (size) => <Footprints size={size} />,
  meditate: (size) => <Brain size={size} />,
  sleep: (size) => <Moon size={size} />,
  food: (size) => <Apple size={size} />,
  heart: (size) => <Heart size={size} />,
  star: (size) => <Star size={size} />,
};
export const perPeriod = { daily: 'por dia', weekly: 'por semana', monthly: 'por mês' } as const;
const periodPhrase = { daily: 'hoje', weekly: 'nesta semana', monthly: 'neste mês' } as const;
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const short = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;
const statusLabel: Record<PeriodResult['status'], string> = {
  met: 'cumprido',
  missed: 'perdido',
  frozen: 'salvo por congelamento',
  skipped: 'não contou',
  open: 'em aberto',
};
function periodName(goal: GoalView, r: PeriodResult) {
  if (goal.period === 'daily')
    return `${WEEKDAYS[new Date(`${r.start}T12:00:00Z`).getUTCDay()]} ${short(r.start)}`;
  if (goal.period === 'weekly') return `semana de ${short(r.start)}`;
  return `${MONTHS[Number(r.start.slice(5, 7)) - 1]}/${r.start.slice(0, 4)}`;
}
// Primeiro o que ainda dá tempo de salvar: ofensiva em risco, depois o que está em aberto.
function rank(goal: GoalView) {
  const { status } = goal.progress.current;
  if (goal.archivedAt) return 4;
  if (status === 'open') return goal.progress.streak > 0 ? 0 : 1;
  return status === 'met' ? 2 : 3;
}

export function Goals({
  offline,
  revision,
  refresh,
}: {
  offline: boolean;
  revision: number;
  refresh: () => Promise<void>;
}) {
  const [data, setData] = useState<GoalsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<GoalView | 'new' | null>(null);
  const [archived, setArchived] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<{ body: string; id: string } | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (offline) return;
    setLoading(true);
    try {
      const result = await api<GoalsData>('goals');
      if (current === generation.current) {
        setData(result);
        setError('');
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [offline]);
  useEffect(() => {
    void load();
  }, [load, revision, reload]);
  async function act(commands: Command[]) {
    if (busy) return false;
    if (offline || !navigator.onLine) {
      setError('Conecte-se para registrar ou alterar metas.');
      return false;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // O mesmo pedido repetido (duplo toque, rede instável) reaproveita o ID e não duplica o
      // registro.
      const body = JSON.stringify(commands);
      if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
      const result = await api<{ reply: string; clarification: boolean }>('actions', {
        commands,
        requestId: request.current.id,
      });
      request.current = null;
      if (result.clarification) throw new Error(result.reply);
      setNotice(result.reply);
      await refresh();
      setReload((n) => n + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (offline)
    return (
      <section className="goals-view">
        <h1>Metas</h1>
        <p role="status">Conecte-se para ver e registrar suas metas. Elas não ficam offline.</p>
      </section>
    );
  const goals = [...(data?.goals ?? [])]
    .filter((g) => archived || !g.archivedAt)
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  const perfect = data?.perfect;
  return (
    <section className="goals-view" aria-label="Metas">
      <div className="page-heading">
        <div>
          <h1>Metas</h1>
          <p>Hábitos com ofensiva: cumpra no prazo para a chama não apagar.</p>
        </div>
        <div className="heading-actions">
          <button
            className="icon-button outlined"
            aria-label="Atualizar metas"
            title="Atualizar"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
          <button className="button primary" disabled={!data} onClick={() => setDialog('new')}>
            <Plus size={18} />
            Nova meta
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="goals-notice" role="status">
          {notice}
        </p>
      )}
      {perfect && perfect.goals > 0 && (
        <div
          className={`perfect-days ${perfect.today === 'met' ? 'lit' : ''}`}
          aria-label="Dias perfeitos"
        >
          <span className="perfect-flame">
            <Flame size={30} />
          </span>
          <div>
            <strong>
              {perfect.streak === 1
                ? '1 dia perfeito'
                : `${perfect.streak} dias perfeitos seguidos`}
            </strong>
            <span>
              {perfect.today === 'met'
                ? 'Hoje já está garantido: todas as metas diárias cumpridas.'
                : perfect.today === 'open'
                  ? 'Cumpra todas as metas diárias de hoje para somar mais um.'
                  : 'Nenhuma meta diária vale hoje.'}
            </span>
          </div>
          <span className="perfect-meta">
            <Trophy size={15} /> Recorde {perfect.best}
            {perfect.freezes > 0 && (
              <span title="Congelamentos guardados: salvam um dia perdido">
                <Snowflake size={15} /> {perfect.freezes}
              </span>
            )}
          </span>
        </div>
      )}
      {data && !data.goals.length && (
        <div className="empty-state goals-empty">
          <span className="empty-icon">
            <Target size={30} />
          </span>
          <h3>Nenhuma meta ainda</h3>
          <p>Comece com algo pequeno, como beber 2,5 L de água por dia ou treinar 3x na semana.</p>
          <button className="button primary" onClick={() => setDialog('new')}>
            <Plus size={16} />
            Criar primeira meta
          </button>
        </div>
      )}
      <div className="goal-grid">
        {data &&
          goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              graceDate={data.graceDate}
              today={data.today}
              busy={busy}
              act={act}
              edit={() => setDialog(goal)}
            />
          ))}
      </div>
      {data?.goals.some((g) => g.archivedAt) && (
        <label className="check-label goals-archived">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Mostrar metas arquivadas
        </label>
      )}
      {dialog && data && (
        <GoalDialog
          goal={dialog === 'new' ? undefined : dialog}
          today={data.today}
          busy={busy}
          act={act}
          close={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function GoalCard({
  goal,
  graceDate,
  today,
  busy,
  act,
  edit,
}: {
  goal: GoalView;
  graceDate: string | null;
  today: string;
  busy: boolean;
  act: (commands: Command[]) => Promise<boolean>;
  edit: () => void;
}) {
  const [custom, setCustom] = useState('');
  const [yesterday, setYesterday] = useState(false);
  const p = goal.progress;
  const current = p.current;
  const percent = Math.min(100, current.target ? (100 * current.amount) / current.target : 0);
  const canYesterday = Boolean(graceDate && graceDate >= goal.startDate && !goal.archivedAt);
  const date = yesterday && canYesterday ? graceDate! : undefined;
  const open = new Set([today, ...(graceDate ? [graceDate] : [])]);
  const log = (amount?: string) =>
    act([
      {
        op: 'goal_log',
        goal: goal.id,
        ...(amount ? { amount } : {}),
        ...(date ? { date } : {}),
      },
    ]);
  const chip =
    current.status === 'met'
      ? ['met', 'Cumprida']
      : current.status === 'skipped'
        ? ['skipped', 'Não conta hoje']
        : p.impossible
          ? ['lost', 'Não dá mais neste período']
          : p.streak > 0
            ? ['risk', 'Em risco']
            : ['open', 'Em andamento'];
  const single = goal.kind === 'count' && goal.period === 'daily' && current.target === 1;
  return (
    <article className={`goal-card status-${chip[0]}${goal.archivedAt ? ' archived' : ''}`}>
      <header>
        <span className="goal-icon">{goalIcons[goal.icon](20)}</span>
        <div>
          <h2>{goal.title}</h2>
          <small>
            {formatAmount(current.target, goal.unit)} {perPeriod[goal.period]}
            {goal.weekdays && ` · ${goal.weekdays.map((d) => WEEKDAYS[d]).join(', ')}`}
            {goal.archivedAt && ' · arquivada'}
          </small>
        </div>
        <button className="icon-button" aria-label={`Editar meta ${goal.title}`} onClick={edit}>
          <Pencil size={16} />
        </button>
      </header>
      <div className="goal-streak">
        <span className={`goal-flame ${p.streak > 0 ? 'lit' : ''}`}>
          <Flame size={22} />
          <strong>{p.streak}</strong>
        </span>
        <span>
          {periodNoun[goal.period][p.streak === 1 ? 0 : 1]} de ofensiva
          <small>
            Recorde {streakLabel(p.best, goal.period)}
            {p.freezes > 0 && (
              <span
                className="goal-freezes"
                title="Congelamentos guardados: salvam um período perdido"
              >
                {' · '}
                <Snowflake size={12} /> {p.freezes}
              </span>
            )}
          </small>
        </span>
        <span className={`goal-chip ${chip[0]}`}>{chip[1]}</span>
      </div>
      <div className="goal-progress">
        <div
          className="goal-bar"
          role="progressbar"
          aria-label={`Progresso de ${goal.title}`}
          aria-valuemin={0}
          aria-valuemax={current.target}
          aria-valuenow={current.amount}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        {single ? (
          <p>
            <strong>{current.amount >= 1 ? 'Feito hoje' : 'Ainda não feito hoje'}</strong>
          </p>
        ) : (
          <p>
            <strong>{formatAmount(current.amount, goal.unit)}</strong> de{' '}
            {formatAmount(current.target, goal.unit)} {periodPhrase[goal.period]}
            {current.status === 'open' && !p.impossible && (
              <>
                {' · '}faltam {formatAmount(p.remaining, goal.unit)}
                {goal.period !== 'daily' && ` em ${p.daysLeft} dia(s)`}
              </>
            )}
          </p>
        )}
      </div>
      {p.lost !== null && current.status !== 'met' && (
        <p className="goal-alert">
          A ofensiva de {streakLabel(p.lost, goal.period)} acabou. Recomece{' '}
          {goal.period === 'daily' ? 'hoje' : 'neste período'}.
        </p>
      )}
      {p.grace && (
        <p className="goal-alert soft">
          Ontem ficou em {formatAmount(p.grace.amount, goal.unit)} de{' '}
          {formatAmount(p.grace.target, goal.unit)}. Dá para registrar até as 12h.
        </p>
      )}
      {!goal.archivedAt && (
        <div className="goal-actions">
          {canYesterday && (
            <div className="goal-day" role="group" aria-label={`Dia do registro de ${goal.title}`}>
              <button
                className={!yesterday ? 'active' : ''}
                aria-pressed={!yesterday}
                onClick={() => setYesterday(false)}
              >
                Hoje
              </button>
              <button
                className={yesterday ? 'active' : ''}
                aria-pressed={yesterday}
                onClick={() => setYesterday(true)}
              >
                Ontem
              </button>
            </div>
          )}
          <div className="goal-quick">
            {goal.kind === 'count' ? (
              <button className="button secondary" disabled={busy} onClick={() => void log()}>
                {single ? 'Feito' : '+1'}
              </button>
            ) : (
              goal.quickAdds.map((value, index) => (
                <button
                  key={index}
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void log(String(value))}
                >
                  +{formatAmount(value, goal.unit)}
                </button>
              ))
            )}
          </div>
          <form
            className="goal-custom"
            onSubmit={async (e) => {
              e.preventDefault();
              if (custom.trim() && (await log(custom.trim()))) setCustom('');
            }}
          >
            <input
              aria-label={`Outra quantidade para ${goal.title}`}
              placeholder={`Outra quantidade (${goal.unit})`}
              value={custom}
              maxLength={40}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button className="button secondary" disabled={busy || !custom.trim()}>
              Registrar
            </button>
          </form>
        </div>
      )}
      <ol className="goal-strip" aria-label={`Últimos períodos de ${goal.title}`}>
        {p.recent.map((r) => (
          <li
            key={r.start}
            className={r.status}
            title={`${periodName(goal, r)}: ${statusLabel[r.status]} (${formatAmount(r.amount, goal.unit)} de ${formatAmount(r.target, goal.unit)})`}
          >
            <span aria-hidden="true">{r.status === 'frozen' ? <Snowflake size={11} /> : null}</span>
            <small>{periodName(goal, r).split(' ')[0]}</small>
            <span className="visually-hidden">
              {periodName(goal, r)}: {statusLabel[r.status]}
            </span>
          </li>
        ))}
      </ol>
      {goal.logs.length > 0 && (
        <details className="goal-logs">
          <summary>Registros recentes ({goal.logs.length})</summary>
          <ul>
            {goal.logs.map((l) => (
              <li key={l.id}>
                <span>
                  {l.date === today ? 'Hoje' : short(l.date)} · +{formatAmount(l.amount, goal.unit)}
                  {l.source === 'web' && <em> pelo chat</em>}
                </span>
                {open.has(l.date) && (
                  <button
                    className="icon-button tiny"
                    aria-label={`Remover registro de ${formatAmount(l.amount, goal.unit)}`}
                    disabled={busy}
                    onClick={() => void act([{ op: 'goal_delete_log', entry: l.id }])}
                  >
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
