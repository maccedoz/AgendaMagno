'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command } from '@/backend/domain';
import type {
  FinanceData,
  FinanceEntry,
  FinanceCategory,
  FinanceTemplate,
} from '@/backend/finance/types';
import { api } from './api';
import { today } from './format';
import { Dialog } from './Dialog';
import { FinancePlan } from './FinancePlan';
const money = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v / 100);
const dateLabel = (v: string) => v.split('-').reverse().join('/');
const amountInput = (cents: number) =>
  `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
type Prefill = {
  kind: 'income' | 'expense';
  amount: string;
  description: string;
  category: string;
};
// Mês e ano em listas, e não em <input type="month">: o Firefox não desenha o seletor desse
// campo e deixa a pessoa sem nada para escolher.
const months = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];
function years(selected: string) {
  const current = Number(today().slice(0, 4));
  const list = Array.from({ length: 11 }, (_, i) => String(current - 5 + i));
  const chosen = selected.slice(0, 4);
  return list.includes(chosen) ? list : [...list, chosen].sort();
}
export function Finance({
  offline,
  revision,
  refresh,
}: {
  offline: boolean;
  revision: number;
  refresh: () => Promise<void>;
}) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [kind, setKind] = useState(''),
    [category, setCategory] = useState('');
  const [fromDate, setFrom] = useState(''),
    [toDate, setTo] = useState('');
  const [deleted, setDeleted] = useState(false),
    [page, setPage] = useState(1);
  const [data, setData] = useState<FinanceData | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<'entries' | 'plan'>('entries');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [entry, setEntry] = useState<FinanceEntry | 'new' | null>(null);
  const [cat, setCat] = useState<FinanceCategory | 'new' | null>(null);
  const [template, setTemplate] = useState<FinanceTemplate | 'new' | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const request = useRef<{ body: string; id: string } | null>(null),
    generation = useRef(0),
    lock = useRef(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (offline || !navigator.onLine) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ month, page: String(page), deleted: String(deleted) });
      Object.entries({ kind, category, fromDate, toDate }).forEach(([k, v]) => {
        if (v) params.set(k, v);
      });
      const result = await api<FinanceData>(`finance?${params}`);
      if (current === generation.current) {
        setData(result);
        setError('');
      }
    } catch (e) {
      if (current === generation.current) {
        setData(null);
        setError((e as Error).message);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [offline, month, page, deleted, kind, category, fromDate, toDate]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, revision, reload]);
  async function action(commands: Command[]) {
    if (lock.current) return;
    if (offline || !navigator.onLine) {
      setError('Conecte-se para alterar o financeiro.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body = JSON.stringify(commands);
      if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
      const result = await api<{ reply: string; clarification: boolean }>('actions', {
        commands,
        requestId: request.current.id,
      });
      if (result.clarification) {
        request.current = null;
        throw new Error(result.reply);
      }
      request.current = null;
      setNotice(result.reply);
      setEntry(null);
      setCat(null);
      setTemplate(null);
      setPrefill(null);
      await refresh();
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const filter = (fn: () => void) => {
    fn();
    setPage(1);
  };
  if (offline)
    return (
      <section className="finance-view">
        <h1>Financeiro</h1>
        <p role="status">
          Conecte-se para consultar ou alterar suas finanças. Os dados financeiros não ficam
          disponíveis offline.
        </p>
      </section>
    );
  return (
    <section className="finance-view" aria-label="Financeiro">
      <div className="page-heading">
        <div>
          <h1>Financeiro</h1>
          <p>Acompanhe suas receitas, despesas e categorias.</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" disabled={loading} onClick={() => void load()}>
            Atualizar financeiro
          </button>
          <button
            className="button primary"
            disabled={!data || busy}
            onClick={() => setEntry('new')}
          >
            Novo lançamento
          </button>
        </div>
      </div>
      <div className="finance-tabs" role="tablist" aria-label="Seções do financeiro">
        {(
          [
            ['entries', 'Lançamentos'],
            ['plan', 'Planejamento'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="finance-filters">
        <label>
          Mês
          <select
            aria-label="Mês"
            value={month.slice(5)}
            onChange={(e) =>
              filter(() => {
                setMonth(`${month.slice(0, 4)}-${e.target.value}`);
                setFrom('');
                setTo('');
              })
            }
          >
            {months.map((name, i) => (
              <option key={name} value={String(i + 1).padStart(2, '0')}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ano
          <select
            aria-label="Ano"
            value={month.slice(0, 4)}
            onChange={(e) =>
              filter(() => {
                setMonth(`${e.target.value}-${month.slice(5)}`);
                setFrom('');
                setTo('');
              })
            }
          >
            {years(month).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        {tab === 'entries' && (
          <>
            <label>
              De
              <input
                type="date"
                value={fromDate}
                onChange={(e) => filter(() => setFrom(e.target.value))}
              />
            </label>
            <label>
              Até
              <input
                type="date"
                value={toDate}
                onChange={(e) => filter(() => setTo(e.target.value))}
              />
            </label>
            <label>
              Tipo
              <select
                aria-label="Tipo do filtro"
                value={kind}
                onChange={(e) => filter(() => setKind(e.target.value))}
              >
                <option value="">Receitas e despesas</option>
                <option value="income">Receitas</option>
                <option value="expense">Despesas</option>
              </select>
            </label>
            <label>
              Categoria
              <select
                aria-label="Categoria do filtro"
                value={category}
                onChange={(e) => filter(() => setCategory(e.target.value))}
              >
                <option value="">Todas as categorias</option>
                {data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.archivedAt ? ' (arquivada)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {tab === 'plan' && <FinancePlan month={month} offline={offline} reload={reload + revision} />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Atualizando financeiro…</p>}
      {tab === 'entries' && data && (
        <>
          <div className="finance-cards" aria-label="Resumo financeiro">
            <article>
              <span>Receitas</span>
              <strong>{money(data.totals.income)}</strong>
            </article>
            <article>
              <span>Despesas</span>
              <strong>{money(data.totals.expense)}</strong>
            </article>
            <article>
              <span>{fromDate || toDate ? 'Resultado do período' : 'Resultado mensal'}</span>
              <strong>{money(data.totals.result)}</strong>
              <small>Receitas menos despesas do período</small>
            </article>
          </div>
          <p className="finance-comparison">
            Mês anterior ao início do período: receitas {money(data.previous.income)}, despesas{' '}
            {money(data.previous.expense)}, resultado {money(data.previous.result)}.{' '}
            {data.previous.expense
              ? `Variação das despesas: ${((data.totals.expense / data.previous.expense - 1) * 100).toFixed(1).replace('.', ',')}%.`
              : 'Sem base de despesas para comparação percentual.'}
          </p>
          <div className="finance-charts">
            <section className="finance-panel">
              <h2>Por categoria</h2>
              {(['income', 'expense'] as const).map((k) => {
                const rows = data.byCategory.filter((c) => c[k] > 0);
                return (
                  <div className="category-group" key={k}>
                    <h3>
                      {k === 'income' ? 'Recebido em cada categoria' : 'Gasto em cada categoria'}
                    </h3>
                    {!rows.length ? (
                      <p>
                        {k === 'income'
                          ? 'Nenhuma receita no período.'
                          : 'Nenhuma despesa no período.'}
                      </p>
                    ) : (
                      rows.map((c) => (
                        <button
                          className="category-bar"
                          key={`${k}-${c.id}`}
                          onClick={() =>
                            filter(() => {
                              setCategory(c.id);
                              setKind(k);
                            })
                          }
                        >
                          <span>{c.name}</span>
                          <strong>
                            {money(c[k])} · {((100 * c[k]) / (data.totals[k] || 1)).toFixed(1)}%
                          </strong>
                          <meter
                            min={0}
                            max={data.totals[k] || 1}
                            value={c[k]}
                            aria-label={`${k === 'income' ? 'Recebido' : 'Gasto'} em ${c.name}`}
                          />
                        </button>
                      ))
                    )}
                  </div>
                );
              })}
            </section>
            <section className="finance-panel">
              <h2>Evolução diária</h2>
              {!data.daily.length ? (
                <p>Nenhum lançamento no período.</p>
              ) : (
                <div className="finance-table-wrap">
                  <table>
                    <caption>Receitas e despesas por dia</caption>
                    <thead>
                      <tr>
                        <th>Dia</th>
                        <th>Receitas</th>
                        <th>Despesas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.daily.map((d) => (
                        <tr key={d.date}>
                          <th>{dateLabel(d.date)}</th>
                          {(['income', 'expense'] as const).map((k) => (
                            <td key={k}>
                              {money(d[k])}
                              <meter
                                aria-label={`${k === 'income' ? 'Receitas' : 'Despesas'} em ${dateLabel(d.date)}`}
                                min={0}
                                max={Math.max(
                                  1,
                                  ...data.daily.flatMap((x) => [x.income, x.expense]),
                                )}
                                value={d[k]}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
          <section className="finance-panel">
            <div className="list-toolbar">
              <h2>Lançamentos</h2>
              <label>
                <input
                  type="checkbox"
                  checked={deleted}
                  onChange={(e) => filter(() => setDeleted(e.target.checked))}
                />
                Ver excluídos
              </label>
            </div>
            {deleted && <p>Excluídos não entram nos totais e gráficos.</p>}
            {!data.entries.length ? (
              <p>Nenhum lançamento encontrado.</p>
            ) : (
              <div className="finance-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Descrição</th>
                      <th>Categoria</th>
                      <th>Tipo</th>
                      <th>Valor</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e) => (
                      <tr key={e.id}>
                        <td>{dateLabel(e.date)}</td>
                        <td className="finance-description">{e.description}</td>
                        <td>{data.categories.find((c) => c.id === e.categoryId)?.name}</td>
                        <td>{e.kind === 'income' ? 'Receita' : 'Despesa'}</td>
                        <td>{money(e.amountCents)}</td>
                        <td>
                          <div className="finance-row-actions">
                            {e.deletedAt ? (
                              <button
                                className="text-button"
                                disabled={busy || loading}
                                onClick={() =>
                                  void action([
                                    {
                                      op: 'finance_restore',
                                      entry: e.id,
                                      expectedVersion: e.version,
                                    },
                                  ])
                                }
                              >
                                Restaurar
                              </button>
                            ) : (
                              <>
                                <button
                                  className="text-button"
                                  disabled={busy || loading}
                                  onClick={() => setEntry(e)}
                                >
                                  Editar
                                </button>
                                <button
                                  className="text-button danger"
                                  disabled={busy || loading}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Excluir ${e.description} (${money(e.amountCents)})? Você poderá restaurar depois.`,
                                      )
                                    )
                                      void action([
                                        {
                                          op: 'finance_delete',
                                          entry: e.id,
                                          expectedVersion: e.version,
                                          confirmed: true,
                                        },
                                      ]);
                                  }}
                                >
                                  Excluir
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="finance-pagination">
              <button
                className="button secondary"
                disabled={page === 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Anterior
              </button>
              <span>
                Página {page} · {data.total} lançamento(s)
              </span>
              <button
                className="button secondary"
                disabled={page * 20 >= data.total || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Próxima
              </button>
            </div>
          </section>
          <section className="finance-panel">
            <div className="list-toolbar">
              <h2>Modelos de lançamento</h2>
              <button
                className="button secondary"
                disabled={busy || loading}
                onClick={() => setTemplate('new')}
              >
                Novo modelo
              </button>
            </div>
            {!data.templates.length ? (
              <p>
                Guarde aqui o que se repete, como aluguel ou salário, e lance com um clique
                escolhendo a data.
              </p>
            ) : (
              data.templates.map((t) => (
                <div className="finance-category-row" key={t.id}>
                  <span>
                    {t.name} · {t.kind === 'income' ? 'Receita' : 'Despesa'} ·{' '}
                    {money(t.amountCents)} ·{' '}
                    {data.categories.find((c) => c.id === t.categoryId)?.name}
                  </span>
                  <div className="finance-row-actions">
                    <button
                      className="button secondary"
                      disabled={busy || loading}
                      onClick={() => {
                        setPrefill({
                          kind: t.kind,
                          amount: amountInput(t.amountCents),
                          description: t.description,
                          category: t.categoryId,
                        });
                        setEntry('new');
                      }}
                    >
                      Lançar {t.name}
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || loading}
                      onClick={() => setTemplate(t)}
                    >
                      Editar modelo
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy || loading}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Excluir o modelo ${t.name}? Os lançamentos já feitos continuam.`,
                          )
                        )
                          void action([
                            {
                              op: 'finance_delete_template',
                              template: t.id,
                              expectedVersion: t.version,
                            },
                          ]);
                      }}
                    >
                      Excluir modelo
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
          <details className="finance-panel">
            <summary>Gerenciar categorias</summary>
            <button
              className="button secondary"
              disabled={busy || loading}
              onClick={() => setCat('new')}
            >
              Nova categoria
            </button>
            {data.categories.map((c) => (
              <div className="finance-category-row" key={c.id}>
                <span>
                  {c.name} ·{' '}
                  {c.kind === 'both'
                    ? 'Receitas e despesas'
                    : c.kind === 'income'
                      ? 'Receitas'
                      : 'Despesas'}
                  {c.archivedAt ? ' · Arquivada' : ''}
                </span>
                <div className="finance-row-actions">
                  <button
                    className="text-button"
                    disabled={busy || loading}
                    onClick={() => setCat(c)}
                  >
                    Editar categoria
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || loading}
                    onClick={() =>
                      void action([
                        {
                          op: c.archivedAt
                            ? 'finance_restore_category'
                            : 'finance_archive_category',
                          category: c.id,
                          expectedVersion: c.version,
                        },
                      ])
                    }
                  >
                    {c.archivedAt ? 'Reativar' : 'Arquivar'}
                  </button>
                </div>
              </div>
            ))}
          </details>
        </>
      )}
      {entry && data && (
        <EntryEditor
          entry={entry === 'new' ? undefined : entry}
          prefill={prefill ?? undefined}
          categories={data.categories}
          busy={busy}
          error={error}
          close={() => {
            if (!busy) {
              setEntry(null);
              setPrefill(null);
            }
          }}
          save={action}
        />
      )}
      {template && data && (
        <TemplateEditor
          template={template === 'new' ? undefined : template}
          categories={data.categories}
          busy={busy}
          error={error}
          close={() => {
            if (!busy) setTemplate(null);
          }}
          save={action}
        />
      )}
      {cat && (
        <CategoryEditor
          category={cat === 'new' ? undefined : cat}
          busy={busy}
          error={error}
          close={() => {
            if (!busy) setCat(null);
          }}
          save={action}
        />
      )}
    </section>
  );
}
function EntryEditor({
  entry,
  prefill,
  categories,
  busy,
  error,
  close,
  save,
}: {
  entry?: FinanceEntry;
  prefill?: Prefill;
  categories: FinanceCategory[];
  busy: boolean;
  error: string;
  close: () => void;
  save: (c: Command[]) => Promise<void>;
}) {
  const [kind, setKind] = useState<'income' | 'expense'>(entry?.kind ?? prefill?.kind ?? 'expense');
  const [amount, setAmount] = useState(
    entry ? amountInput(entry.amountCents) : (prefill?.amount ?? ''),
  );
  const [date, setDate] = useState(entry?.date ?? today()),
    [description, setDescription] = useState(entry?.description ?? prefill?.description ?? '');
  const [category, setCategory] = useState(
    entry?.categoryId ??
      prefill?.category ??
      categories.find((c) => c.name.toLowerCase() === 'sem categoria' && !c.archivedAt)?.id ??
      '',
  );
  return (
    <Dialog
      title={entry ? 'Editar lançamento' : 'Novo lançamento'}
      subtitle="Valores efetivamente recebidos ou gastos, em reais."
      close={close}
    >
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save([
            {
              op: entry ? 'finance_update' : 'finance_create',
              ...(entry ? { entry: entry.id, expectedVersion: entry.version } : {}),
              kind,
              amount,
              date,
              description,
              category,
            },
          ]);
        }}
      >
        <fieldset disabled={busy}>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <label htmlFor="finance-kind">Tipo do lançamento</label>
          <select
            id="finance-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setCategory('');
            }}
          >
            <option value="expense">Despesa</option>
            <option value="income">Receita</option>
          </select>
          <label htmlFor="finance-amount">Valor em reais</label>
          <input
            id="finance-amount"
            inputMode="decimal"
            placeholder="1.234,56"
            required
            maxLength={40}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <label htmlFor="finance-date">Data do lançamento</label>
          <input
            id="finance-date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <label htmlFor="finance-description">Descrição do lançamento</label>
          <textarea
            id="finance-description"
            required
            maxLength={5000}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label htmlFor="finance-category">Categoria do lançamento</label>
          <select
            id="finance-category"
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Escolha uma categoria</option>
            {categories
              .filter(
                (c) =>
                  (!c.archivedAt || c.id === entry?.categoryId || c.id === prefill?.category) &&
                  (c.kind === kind || c.kind === 'both'),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archivedAt ? ' (arquivada)' : ''}
                </option>
              ))}
          </select>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={close}>
              Cancelar
            </button>
            <button className="button primary">Salvar lançamento</button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
function CategoryEditor({
  category,
  busy,
  error,
  close,
  save,
}: {
  category?: FinanceCategory;
  busy: boolean;
  error: string;
  close: () => void;
  save: (c: Command[]) => Promise<void>;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState<FinanceCategory['kind']>(category?.kind ?? 'expense');
  return (
    <Dialog title={category ? 'Editar categoria' : 'Nova categoria'} close={close}>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save([
            {
              op: category ? 'finance_update_category' : 'finance_create_category',
              ...(category ? { category: category.id, expectedVersion: category.version } : {}),
              name,
              categoryKind: kind,
            },
          ]);
        }}
      >
        <fieldset disabled={busy}>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <label htmlFor="category-name">Nome da categoria</label>
          <input
            id="category-name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="category-kind">Aceitar lançamentos de</label>
          <select
            id="category-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="expense">Despesas</option>
            <option value="income">Receitas</option>
            <option value="both">Receitas e despesas</option>
          </select>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={close}>
              Cancelar
            </button>
            <button className="button primary">Salvar categoria</button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
function TemplateEditor({
  template,
  categories,
  busy,
  error,
  close,
  save,
}: {
  template?: FinanceTemplate;
  categories: FinanceCategory[];
  busy: boolean;
  error: string;
  close: () => void;
  save: (c: Command[]) => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [kind, setKind] = useState<'income' | 'expense'>(template?.kind ?? 'expense');
  const [amount, setAmount] = useState(template ? amountInput(template.amountCents) : '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [category, setCategory] = useState(template?.categoryId ?? '');
  return (
    <Dialog
      title={template ? 'Editar modelo' : 'Novo modelo'}
      subtitle="O que se repete todo mês. A data é escolhida na hora de lançar."
      close={close}
    >
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save([
            {
              op: template ? 'finance_update_template' : 'finance_create_template',
              ...(template ? { template: template.id, expectedVersion: template.version } : {}),
              name,
              kind,
              amount,
              description,
              category,
            },
          ]);
        }}
      >
        <fieldset disabled={busy}>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <label htmlFor="template-name">Nome do modelo</label>
          <input
            id="template-name"
            required
            maxLength={100}
            placeholder="Aluguel"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="template-kind">Tipo do modelo</label>
          <select
            id="template-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setCategory('');
            }}
          >
            <option value="expense">Despesa</option>
            <option value="income">Receita</option>
          </select>
          <label htmlFor="template-amount">Valor padrão em reais</label>
          <input
            id="template-amount"
            inputMode="decimal"
            placeholder="1.234,56"
            required
            maxLength={40}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <label htmlFor="template-description">Descrição padrão</label>
          <textarea
            id="template-description"
            required
            maxLength={5000}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label htmlFor="template-category">Categoria do modelo</label>
          <select
            id="template-category"
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Escolha uma categoria</option>
            {categories
              .filter(
                (c) =>
                  (!c.archivedAt || c.id === template?.categoryId) &&
                  (c.kind === kind || c.kind === 'both'),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archivedAt ? ' (arquivada)' : ''}
                </option>
              ))}
          </select>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={close}>
              Cancelar
            </button>
            <button className="button primary">Salvar modelo</button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
