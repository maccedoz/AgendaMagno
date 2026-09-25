'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SummaryTask, WeekSummary } from '@/backend/summary';
import { api } from './api';
import { formatAmount, streakLabel } from '@/shared/goals';

const money = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v / 100);
const short = (date: string) => date.slice(5).split('-').reverse().join('/');
const dueText = (t: SummaryTask) =>
  t.dueDate ? `${short(t.dueDate)}${t.dueTime ? ` · ${t.dueTime}` : ''}` : 'Sem prazo';
const doneText = (t: SummaryTask) =>
  t.completedAt
    ? `Concluída em ${new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Bahia',
        day: '2-digit',
        month: '2-digit',
      }).format(new Date(t.completedAt))}`
    : 'Concluída';

function TaskList({
  title,
  total,
  items,
  empty,
  detail,
  tone,
}: {
  title: string;
  total: number;
  items: SummaryTask[];
  empty: string;
  detail: (t: SummaryTask) => string;
  tone?: 'danger';
}) {
  return (
    <section className="summary-panel">
      <h2>
        {title} <span className="summary-count">{total}</span>
      </h2>
      {!items.length ? (
        <p className="summary-empty">{empty}</p>
      ) : (
        <ul className="summary-list">
          {items.map((t) => (
            <li key={t.id}>
              <span className="summary-task-id">#{t.id}</span>
              <div>
                <strong>{t.title}</strong>
                <small className={tone === 'danger' ? 'summary-late' : undefined}>
                  {detail(t)}
                  {t.group ? ` · ${t.group}` : ''}
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > items.length && (
        <p className="summary-more">E mais {total - items.length} tarefa(s).</p>
      )}
    </section>
  );
}

// Resumo pronto do servidor: a tela só escolhe a semana e desenha. O mesmo cálculo responde
// “como foi minha semana” no assistente, então os números batem nos dois lugares.
export function WeeklySummary({ offline, revision }: { offline: boolean; revision: number }) {
  // Deslocamento em semanas a partir da atual; o servidor resolve qual segunda-feira é essa.
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<WeekSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (offline || !navigator.onLine) return;
    setLoading(true);
    try {
      const result = await api<WeekSummary>(`summary?week=${offset}`);
      if (current === generation.current) {
        setData(result);
        setError('');
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
    // revision recarrega o resumo quando uma tarefa ou lançamento muda em outra tela.
  }, [offline, offset, revision]);
  useEffect(() => {
    void load();
  }, [load]);
  if (offline)
    return (
      <section className="summary-view">
        <h1>Resumo da semana</h1>
        <p role="status">
          Conecte-se para ver o resumo da semana. Ele soma tarefas e finanças no servidor e não fica
          disponível offline.
        </p>
      </section>
    );
  const range = data
    ? `${short(data.start)} a ${short(data.end)}/${data.end.slice(0, 4)}`
    : 'Carregando semana';
  const finance = data?.finance;
  const change =
    finance && finance.previous.expense
      ? (finance.totals.expense / finance.previous.expense - 1) * 100
      : null;
  return (
    <section className="summary-view" aria-label="Resumo da semana">
      <div className="page-heading">
        <div>
          <h1>Resumo da semana</h1>
          <p>O que foi feito, o que ficou para trás e para onde foi o dinheiro.</p>
        </div>
        <div className="summary-nav" aria-label="Escolher semana">
          <button
            className="button secondary"
            disabled={loading}
            onClick={() => setOffset((o) => o - 1)}
          >
            Semana anterior
          </button>
          <span className="summary-range" aria-live="polite">
            {range}
            {data?.current && <small>Semana atual</small>}
          </span>
          <button
            className="button secondary"
            disabled={loading || offset >= 0}
            onClick={() => setOffset((o) => o + 1)}
          >
            Próxima semana
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading && !data && <p role="status">Carregando resumo…</p>}
      {data && finance && (
        <>
          <div className="summary-cards" aria-label="Números da semana">
            <article>
              <span>Concluídas</span>
              <strong>{data.tasks.completed}</strong>
              <small>Tarefas terminadas nesta semana</small>
            </article>
            <article>
              <span>Criadas</span>
              <strong>{data.tasks.created}</strong>
              <small>Tarefas novas nesta semana</small>
            </article>
            <article className={data.tasks.overdue ? 'summary-alert' : undefined}>
              <span>Atrasadas agora</span>
              <strong>{data.tasks.overdue}</strong>
              <small>Em aberto com prazo vencido</small>
            </article>
            <article>
              <span>Semana seguinte</span>
              <strong>{data.tasks.nextWeek}</strong>
              <small>
                Prazos de {short(data.nextStart)} a {short(data.nextEnd)}
              </small>
            </article>
          </div>
          <div className="summary-cards summary-money" aria-label="Finanças da semana">
            <article>
              <span>Receitas</span>
              <strong className="summary-income">{money(finance.totals.income)}</strong>
              <small>Semana anterior: {money(finance.previous.income)}</small>
            </article>
            <article>
              <span>Despesas</span>
              <strong className="summary-expense">{money(finance.totals.expense)}</strong>
              <small>
                Semana anterior: {money(finance.previous.expense)}
                {change !== null &&
                  ` · ${change > 0 ? '+' : ''}${change.toFixed(1).replace('.', ',')}%`}
              </small>
            </article>
            <article>
              <span>Resultado</span>
              <strong>{money(finance.totals.result)}</strong>
              <small>Receitas menos despesas da semana</small>
            </article>
          </div>
          <div className="summary-grid">
            <section className="summary-panel">
              <h2>Maiores despesas</h2>
              {!finance.categories.length ? (
                <p className="summary-empty">
                  {finance.entries
                    ? 'Nenhuma despesa nesta semana.'
                    : 'Nenhum lançamento nesta semana.'}
                </p>
              ) : (
                <ul className="summary-categories">
                  {finance.categories.map((c) => (
                    <li key={c.id}>
                      <div>
                        <span>{c.name}</span>
                        <strong>
                          {money(c.expense)} · {String(c.share).replace('.', ',')}%
                        </strong>
                      </div>
                      <span className="summary-bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(2, c.share)}%` }} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {data.goals.length > 0 && (
              <section className="summary-panel">
                <h2>Metas</h2>
                <ul className="summary-categories">
                  {data.goals.map((g) => {
                    const share =
                      g.period === 'daily'
                        ? (100 * g.met) / Math.max(1, g.periods)
                        : Math.min(100, (100 * g.amount) / Math.max(1, g.target));
                    return (
                      <li key={g.id}>
                        <div>
                          <span>{g.title}</span>
                          <strong>
                            {g.period === 'daily'
                              ? `${g.met} de ${g.periods} dia(s)`
                              : `${formatAmount(g.amount, g.unit)} de ${formatAmount(g.target, g.unit)}`}{' '}
                            · ofensiva de {streakLabel(g.streak, g.period)}
                          </strong>
                        </div>
                        <span className="summary-bar" aria-hidden="true">
                          <span style={{ width: `${Math.max(2, share)}%` }} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <TaskList
              title="Concluídas na semana"
              total={data.tasks.completed}
              items={data.tasks.completedList}
              empty="Nenhuma tarefa concluída nesta semana."
              detail={doneText}
            />
            <TaskList
              title="Atrasadas agora"
              total={data.tasks.overdue}
              items={data.tasks.overdueList}
              empty="Nada atrasado. Tudo em dia."
              detail={dueText}
              tone="danger"
            />
            <TaskList
              title="Prazo na semana seguinte"
              total={data.tasks.nextWeek}
              items={data.tasks.nextWeekList}
              empty="Nenhum prazo na semana seguinte."
              detail={dueText}
            />
          </div>
        </>
      )}
    </section>
  );
}
