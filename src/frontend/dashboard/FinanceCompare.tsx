'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FinanceCompareData } from '@/backend/finance/types';
import { api } from './api';

const money = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v / 100);
const short = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15))
    .toLocaleDateString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    .replace('.', '');
const change = (now: number, before: number | undefined) =>
  before === undefined || before === 0
    ? '—'
    : `${now >= before ? '+' : '−'}${Math.abs((now / before - 1) * 100)
        .toFixed(1)
        .replace('.', ',')}%`;

// Painel comparativo: os últimos meses lado a lado, terminando no mês escolhido no filtro.
export function FinanceCompare({
  month,
  offline,
  reload,
}: {
  month: string;
  offline: boolean;
  reload: number;
}) {
  const [count, setCount] = useState(6);
  const [data, setData] = useState<FinanceCompareData | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (offline || !navigator.onLine) return;
    try {
      const result = await api<FinanceCompareData>(`finance/compare?month=${month}&count=${count}`);
      if (current === generation.current) {
        setData(result);
        setError('');
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    }
  }, [offline, month, count]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, reload]);
  if (!data) return error ? <p className="form-error">{error}</p> : null;
  const top = Math.max(1, ...data.months.flatMap((m) => [m.income, m.expense]));
  const name = (id: string) =>
    data.categories.find((c) => c.id === id)?.name ?? 'Categoria removida';
  const totals = new Map<string, number>();
  for (const m of data.months)
    for (const c of m.byCategory) totals.set(c.id, (totals.get(c.id) ?? 0) + c.expense);
  const topCategories = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const last = data.months[data.months.length - 1];
  const before = data.months[data.months.length - 2];
  return (
    <div className="plan-view compare-view">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <section className="finance-panel" aria-label="Meses lado a lado">
        <div className="list-toolbar">
          <h2>Receitas e despesas por mês</h2>
          <label>
            Meses
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {[3, 6, 12].map((n) => (
                <option key={n} value={n}>
                  Últimos {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="compare-chart" role="img" aria-label="Receitas e despesas de cada mês">
          {data.months.map((m) => (
            <div className="compare-col" key={m.month}>
              <div className="compare-bars">
                <span
                  className="compare-income"
                  style={{ height: `${(100 * m.income) / top}%` }}
                  title={`Receitas ${money(m.income)}`}
                />
                <span
                  className="compare-expense"
                  style={{ height: `${(100 * m.expense) / top}%` }}
                  title={`Despesas ${money(m.expense)}`}
                />
              </div>
              <small>{short(m.month)}</small>
            </div>
          ))}
        </div>
        <p className="compare-legend">
          <span className="compare-income" /> Receitas <span className="compare-expense" /> Despesas
        </p>
        <div className="finance-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mês</th>
                <th>Receitas</th>
                <th>Despesas</th>
                <th>Resultado</th>
                <th>Despesas vs. mês anterior</th>
                <th>Despesas vs. previsto</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m, i) => (
                <tr key={m.month}>
                  <td>{short(m.month)}</td>
                  <td>{money(m.income)}</td>
                  <td>{money(m.expense)}</td>
                  <td className={m.result < 0 ? 'plan-negative' : ''}>{money(m.result)}</td>
                  <td>{change(m.expense, data.months[i - 1]?.expense)}</td>
                  <td>
                    {data.plannedExpense
                      ? m.expense > data.plannedExpense
                        ? `${money(m.expense - data.plannedExpense)} acima`
                        : `${money(data.plannedExpense - m.expense)} abaixo`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <small>
          “Previsto” é o planejamento atual (gastos fixos e limites), aplicado a todos os meses. O
          planejamento não guarda histórico.
        </small>
      </section>
      <section className="finance-panel" aria-label="Despesas por categoria em cada mês">
        <div className="list-toolbar">
          <h2>Maiores categorias de despesa</h2>
          {before && last && (
            <span className="plan-tag">
              {short(last.month)} vs. {short(before.month)}: {change(last.expense, before.expense)}
            </span>
          )}
        </div>
        {!topCategories.length ? (
          <p className="plan-empty">Nenhuma despesa nesse intervalo.</p>
        ) : (
          <div className="finance-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Categoria</th>
                  {data.months.map((m) => (
                    <th key={m.month}>{short(m.month)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topCategories.map(([id]) => (
                  <tr key={id}>
                    <td>{name(id)}</td>
                    {data.months.map((m) => {
                      const value = m.byCategory.find((c) => c.id === id)?.expense ?? 0;
                      return (
                        <td key={m.month}>
                          {value ? money(value) : '—'}
                          <meter
                            min={0}
                            max={top}
                            value={value}
                            aria-label={`${name(id)} em ${short(m.month)}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
