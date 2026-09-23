'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FinanceCategory, FinancePlanData, FinancePlanItem } from '@/backend/finance/types';
import { planSummary, type BudgetRow } from '@/backend/finance/plan';
import { api } from './api';

type Kind = FinancePlanItem['kind'];
const money = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v / 100);
const amountInput = (cents: number) =>
  `${Math.floor(cents / 100).toLocaleString('pt-BR')},${String(cents % 100).padStart(2, '0')}`;
const monthLabel = (month: string) =>
  new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15),
  ).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const stateLabel = (row: BudgetRow) =>
  row.state === 'over'
    ? `Acima do limite em ${money(row.spent - row.limit)}`
    : row.state === 'warning'
      ? `Perto do limite: restam ${money(row.limit - row.spent)}`
      : `Restam ${money(row.limit - row.spent)}`;

export function FinancePlan({
  month,
  offline,
  reload,
}: {
  month: string;
  offline: boolean;
  reload: number;
}) {
  const [data, setData] = useState<FinancePlanData | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // O estado `busy` só chega à tela no próximo render: dois cliques rápidos (excluir um item e
  // logo outro) passavam os dois pela checagem e as recargas concorrentes deixavam a lista velha.
  const running = useRef(false);
  // Um formulário aberto por vez: “novo” de um tipo ou a edição de um item.
  const [editing, setEditing] = useState<{ kind: Kind; item?: FinancePlanItem } | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (offline || !navigator.onLine) return;
    try {
      const result = await api<FinancePlanData>(`finance/plan?month=${month}`);
      if (current === generation.current) setData(result);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    }
  }, [offline, month]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, reload]);
  async function send(path: string, body: unknown, done: string) {
    if (running.current) return;
    if (offline || !navigator.onLine) {
      setError('Conecte-se para alterar o planejamento.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, body);
      setEditing(null);
      setNotice(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  if (!data) return error ? <p className="form-error">{error}</p> : null;
  const summary = planSummary(data.items, data.real);
  const categoryName = (id: string | null) =>
    id ? (data.categories.find((c) => c.id === id)?.name ?? 'Categoria removida') : '';
  const remove = (item: FinancePlanItem, label: string) => {
    if (window.confirm(`Excluir ${label} do planejamento? Nenhum lançamento é afetado.`))
      void send(
        'finance/plan/delete',
        { id: item.id, expectedVersion: item.version },
        `${label} saiu do planejamento.`,
      );
  };
  const form = (kind: Kind, item?: FinancePlanItem) => (
    <PlanForm
      kind={kind}
      item={item}
      categories={data.categories}
      taken={data.items
        .filter((x) => x.kind === 'budget' && x.id !== item?.id)
        .map((x) => x.categoryId!)}
      busy={busy}
      cancel={() => setEditing(null)}
      save={(body) =>
        void send(
          'finance/plan',
          { ...body, kind, ...(item ? { id: item.id, expectedVersion: item.version } : {}) },
          item ? 'Planejamento atualizado.' : 'Item incluído no planejamento.',
        )
      }
    />
  );
  const list = (kind: 'income' | 'fixed', title: string, empty: string) => {
    const rows = data.items.filter((x) => x.kind === kind);
    return (
      <section className="finance-panel" aria-label={title}>
        <div className="list-toolbar">
          <h2>{title}</h2>
          <button className="button secondary" disabled={busy} onClick={() => setEditing({ kind })}>
            {kind === 'income' ? 'Nova renda' : 'Novo gasto fixo'}
          </button>
        </div>
        {editing?.kind === kind && !editing.item && form(kind)}
        {!rows.length && <p className="plan-empty">{empty}</p>}
        {rows.map((item) =>
          editing?.item?.id === item.id ? (
            <div key={item.id}>{form(kind, item)}</div>
          ) : (
            <div className="plan-row" key={item.id}>
              <span>
                {item.name}
                {item.categoryId && <small> · {categoryName(item.categoryId)}</small>}
              </span>
              <strong>{money(item.amountCents)}</strong>
              <div className="finance-row-actions">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setEditing({ kind, item })}
                >
                  Editar {item.name}
                </button>
                <button
                  className="text-button danger"
                  disabled={busy}
                  aria-label={`Excluir ${item.name}`}
                  onClick={() => remove(item, item.name)}
                >
                  Excluir
                </button>
              </div>
            </div>
          ),
        )}
        <p className="plan-total">
          Total por mês:{' '}
          <strong>{money(kind === 'income' ? summary.income : summary.fixed)}</strong>
        </p>
      </section>
    );
  };
  const budgets = data.items.filter((x) => x.kind === 'budget');
  return (
    <div className="plan-view">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <p className="plan-help">
        O planejamento é o que você espera ganhar e gastar todo mês. Ele não é um lançamento: não
        entra no saldo, nos totais, nos gráficos nem no resultado do mês. Os modelos de lançamento
        são diferentes — ao usar um, ele cria um lançamento real.
      </p>
      <section className="finance-panel plan-math" aria-label="Cálculo planejado">
        <div className="list-toolbar">
          <h2>Cálculo planejado</h2>
          <span className="plan-tag">Previsão · não é o saldo da conta</span>
        </div>
        <dl>
          <div>
            <dt>Renda prevista</dt>
            <dd>{money(summary.income)}</dd>
          </div>
          <div>
            <dt>− Gastos fixos</dt>
            <dd>{money(summary.fixed)}</dd>
          </div>
          <div className="plan-subtotal">
            <dt>= Sobra planejada</dt>
            <dd className={summary.leftover < 0 ? 'plan-negative' : ''}>
              {money(summary.leftover)}
            </dd>
          </div>
          <div>
            <dt>− Limites por categoria, além dos fixos</dt>
            <dd>{money(summary.budgetsBeyondFixed)}</dd>
          </div>
          <div className="plan-subtotal">
            <dt>= Livre para gastar</dt>
            <dd className={summary.free < 0 ? 'plan-negative' : ''}>{money(summary.free)}</dd>
          </div>
        </dl>
        <small>
          O limite de uma categoria já inclui os gastos fixos dela: um aluguel em Moradia não é
          descontado duas vezes.
        </small>
      </section>
      <div className="plan-columns">
        {list('income', 'Renda prevista', 'Inclua o que você recebe todo mês, como o salário.')}
        {list('fixed', 'Gastos fixos', 'Inclua contas que se repetem, como aluguel e internet.')}
      </div>
      <section className="finance-panel" aria-label="Planejado e real">
        <div className="list-toolbar">
          <h2>Planejado e real em {monthLabel(data.month)}</h2>
        </div>
        <div className="plan-compare">
          <article>
            <span>Receitas lançadas</span>
            <strong>{money(summary.realIncome)}</strong>
            <small>
              Previsto {money(summary.income)} ·{' '}
              {summary.realIncome >= summary.income
                ? `${money(summary.realIncome - summary.income)} acima`
                : `faltam ${money(summary.income - summary.realIncome)}`}
            </small>
          </article>
          <article>
            <span>Despesas lançadas</span>
            <strong>{money(summary.realExpense)}</strong>
            <small>
              Previsto {money(summary.plannedExpense)} (fixos e limites) ·{' '}
              {summary.realExpense > summary.plannedExpense
                ? `${money(summary.realExpense - summary.plannedExpense)} acima`
                : `restam ${money(summary.plannedExpense - summary.realExpense)}`}
            </small>
          </article>
        </div>
        <div className="list-toolbar plan-budget-head">
          <h3>Limites por categoria</h3>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setEditing({ kind: 'budget' })}
          >
            Novo limite
          </button>
        </div>
        {editing?.kind === 'budget' && !editing.item && form('budget')}
        {!budgets.length && (
          <p className="plan-empty">
            Defina quanto quer gastar por mês em uma categoria de despesa. O aviso aparece a partir
            de 80% do limite.
          </p>
        )}
        {summary.budgetRows.map((row) => {
          const item = budgets.find((x) => x.categoryId === row.categoryId)!;
          const name = categoryName(row.categoryId);
          if (editing?.item?.id === item.id) return <div key={item.id}>{form('budget', item)}</div>;
          return (
            <div className={`plan-budget plan-${row.state}`} key={item.id}>
              <div className="plan-budget-line">
                <span>{name}</span>
                <strong>
                  {money(row.spent)} de {money(row.limit)} · {row.percent}%
                </strong>
              </div>
              <div
                className="plan-bar"
                role="progressbar"
                aria-label={`Gasto em ${name}`}
                aria-valuemin={0}
                aria-valuemax={row.limit}
                aria-valuenow={Math.min(row.spent, row.limit)}
                aria-valuetext={`${row.percent}% do limite`}
              >
                <span style={{ width: `${Math.min(100, row.percent)}%` }} />
              </div>
              <div className="plan-budget-line">
                <small className="plan-state">{stateLabel(row)}</small>
                <div className="finance-row-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setEditing({ kind: 'budget', item })}
                  >
                    Editar limite de {name}
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    aria-label={`Excluir limite de ${name}`}
                    onClick={() => remove(item, `o limite de ${name}`)}
                  >
                    Excluir
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function PlanForm({
  kind,
  item,
  categories,
  taken,
  busy,
  cancel,
  save,
}: {
  kind: Kind;
  item?: FinancePlanItem;
  categories: FinanceCategory[];
  taken: string[];
  busy: boolean;
  cancel: () => void;
  save: (body: { name?: string; amount: string; categoryId: string | null }) => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [amount, setAmount] = useState(item ? amountInput(item.amountCents) : '');
  const [category, setCategory] = useState(item?.categoryId ?? '');
  const label = kind === 'income' ? 'renda' : kind === 'fixed' ? 'gasto fixo' : 'limite';
  const options = categories.filter(
    (c) =>
      c.kind !== 'income' &&
      (!c.archivedAt || c.id === item?.categoryId) &&
      (kind !== 'budget' || !taken.includes(c.id)),
  );
  return (
    <form
      className="plan-form"
      aria-label={item ? `Editar ${label}` : `Novo ${label}`}
      onSubmit={(e) => {
        e.preventDefault();
        save({
          ...(kind === 'budget' ? {} : { name }),
          amount,
          categoryId: kind === 'income' ? null : category || null,
        });
      }}
    >
      <fieldset disabled={busy}>
        {kind !== 'budget' && (
          <label>
            Nome
            <input
              required
              maxLength={100}
              placeholder={kind === 'income' ? 'Salário' : 'Aluguel'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {kind !== 'income' && (
          <label>
            {kind === 'budget' ? 'Categoria' : 'Categoria (opcional)'}
            <select
              required={kind === 'budget'}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">
                {kind === 'budget' ? 'Escolha uma categoria' : 'Sem categoria'}
              </option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archivedAt ? ' (arquivada)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {kind === 'budget' ? 'Limite por mês' : 'Valor por mês'}
          <input
            required
            inputMode="decimal"
            placeholder="1.234,56"
            maxLength={40}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <div className="plan-form-actions">
          <button type="button" className="button secondary" onClick={cancel}>
            Cancelar
          </button>
          <button className="button primary">Salvar {label}</button>
        </div>
      </fieldset>
    </form>
  );
}
