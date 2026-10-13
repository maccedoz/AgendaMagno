import { randomUUID } from 'node:crypto';
import { Ambiguity, DomainError, type Command, type State } from '../domain/types';
import { localDate, normalize } from '../domain/format';
import { MAX_CENTS, type FinanceCategory, type FinanceEntry, type FinancePlanItem } from './types';
import { planSummary } from './plan';
import {
  entriesInPeriod,
  entryTotals,
  financePage,
  groupedTotals,
  monthRange,
  pageHint,
  reportPeriod,
} from './queries';
export const money = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const amountText = (cents: number) =>
  `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
export function parseMoney(value: string): number {
  const text = value.trim().replace(/^R\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text))
    throw new DomainError('Valor inválido. Use o formato 1.234,56, com até duas casas decimais.');
  const [whole, fraction = ''] = text.replaceAll('.', '').split(',');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS)
    throw new DomainError('O valor deve estar entre R$ 0,01 e R$ 999.999.999,99.');
  return cents;
}

// Painel e conversa usam as mesmas regras. A função prepara um item sem gravar: no chat,
// todos os itens só são persistidos depois que o pedido inteiro foi validado.
const MAX_PLAN_ITEMS = 300;
export function prepareFinancePlanItem(
  value: {
    id?: string;
    kind: FinancePlanItem['kind'];
    name?: string;
    amount: string;
    categoryId?: string | null;
    expectedVersion?: number;
  },
  all: FinancePlanItem[],
  categories: FinanceCategory[],
  at: string,
): FinancePlanItem {
  const amountCents = parseMoney(value.amount);
  const current = value.id ? all.find((x) => x.id === value.id) : undefined;
  if (value.id && !current) throw new DomainError('Item do planejamento não encontrado.', 404);
  if (current && value.expectedVersion !== undefined && value.expectedVersion !== current.version)
    throw new DomainError('Este item foi alterado. Atualize antes de salvar.', 409);
  if (current && current.kind !== value.kind)
    throw new DomainError('Não é possível mudar o tipo de um item do planejamento.');
  if (!current && all.length >= MAX_PLAN_ITEMS)
    throw new DomainError(`O planejamento aceita até ${MAX_PLAN_ITEMS} itens.`);
  const others = all.filter((x) => x.id !== current?.id && x.kind === value.kind);
  let name = value.name?.trim() ?? '';
  let categoryId: string | null = null;
  if (value.kind === 'income') {
    if (!name) throw new DomainError('Informe o nome da renda, como Salário.');
  } else {
    if (value.kind === 'fixed' && !name)
      throw new DomainError('Informe o nome do gasto fixo, como Aluguel.');
    if (value.categoryId) {
      const category = categories.find((c) => c.id === value.categoryId);
      if (!category || category.kind === 'income')
        throw new DomainError('Escolha uma categoria de despesa.');
      // Categoria arquivada continua valendo para quem já a usava, mas não para um item novo.
      if (category.archivedAt && category.id !== current?.categoryId)
        throw new DomainError('Escolha uma categoria ativa.');
      categoryId = category.id;
    } else if (value.kind === 'budget') throw new DomainError('Escolha a categoria do limite.');
  }
  if (value.kind === 'budget') {
    name = '';
    if (others.some((x) => x.categoryId === categoryId))
      throw new DomainError('Essa categoria já tem um limite. Edite o existente.');
  } else if (others.some((x) => normalize(x.name) === normalize(name)))
    throw new DomainError(`Já existe um item com esse nome: “${name}”.`);
  return current
    ? { ...current, name, amountCents, categoryId, version: current.version + 1, updatedAt: at }
    : {
        id: randomUUID(),
        kind: value.kind,
        name,
        amountCents,
        categoryId,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
}

const planKindLabel = {
  income: 'Renda prevista',
  fixed: 'Gasto fixo',
  budget: 'Limite por categoria',
};
export const isFinance = (c: Command) => c.op.startsWith('finance_');
export const isFinanceDeletion = (c: Command) =>
  ['finance_delete', 'finance_plan_delete', 'finance_delete_template'].includes(c.op);
export const isFinanceQuery = (c: Command) =>
  [
    'finance_list',
    'finance_summary',
    'finance_plan_list',
    'finance_list_templates',
    'finance_list_categories',
  ].includes(c.op);
// O resumo da semana não é operação financeira (não passa por financeCommand), mas soma
// lançamentos: o serviço precisa carregá-los e a resposta, como a das finanças, não é reescrita.
export const needsFinance = (c: Command) => isFinance(c) || c.op === 'week_summary';
const kindLabel = (kind: 'income' | 'expense' | 'both') =>
  kind === 'both' ? 'receitas e despesas' : kind === 'income' ? 'receitas' : 'despesas';
function required<T>(value: T | undefined, field: 'amount' | 'kind' | 'description') {
  if (value === undefined)
    throw new Ambiguity(
      `Informe ${{ amount: 'o valor (ex.: 42,90)', kind: 'receita ou despesa', description: 'a descrição' }[field]} do lançamento.`,
      field,
      [],
    );
  return value;
}
export function financeCommand(
  state: State,
  c: Command,
  channel: string,
  now: Date,
  batch: Command[] = [c],
): { reply: string; changed: boolean } {
  const f = state.finance;
  if (!f) throw new DomainError('Dados financeiros indisponíveis. Atualize e tente novamente.');
  const at = now.toISOString();
  const checkVersion = (version: number) => {
    if (c.expectedVersion !== undefined && c.expectedVersion !== version)
      throw new DomainError('Este registro foi alterado. Atualize antes de salvar.', 409);
  };
  const category = (ref: string | null | undefined, kind?: string): FinanceCategory => {
    const matches = f.categories.filter(
      (x) => x.id === ref || normalize(x.name) === normalize(ref ?? 'sem categoria'),
    );
    if (matches.length !== 1)
      throw new Ambiguity(
        'Qual categoria deseja usar? Você também pode pedir para criar uma, como “crie a categoria besteiras”.',
        'category',
        f.categories
          .filter((x) => !x.archivedAt && (!kind || x.kind === 'both' || x.kind === kind))
          .map((x) => ({ ref: x.id, label: x.name })),
      );
    const item = matches[0];
    if (kind && item.kind !== 'both' && item.kind !== kind)
      throw new DomainError('Categoria incompatível com o tipo do lançamento.');
    return item;
  };
  const planName = (item: FinancePlanItem) => item.name || category(item.categoryId).name;
  const select = <T extends { id: string; version: number }>(
    items: T[],
    ref: string | undefined,
    field: 'entry' | 'template' | 'planItem',
    question: string,
    name: (item: T) => string,
    label: (item: T) => string,
  ): T => {
    const matches = items.filter(
      (x) => x.id === ref || (ref && normalize(name(x)) === normalize(ref)),
    );
    if (matches.length !== 1)
      throw new Ambiguity(
        question,
        field,
        (matches.length ? matches : items)
          .slice(0, 20)
          .map((x) => ({ ref: x.id, label: label(x) })),
      );
    checkVersion(matches[0].version);
    return matches[0];
  };
  const confirmDeletion = () => {
    if (c.confirmed) return;
    const waiting = batch.filter((x) => isFinanceDeletion(x) && !x.confirmed);
    // Vincula a confirmação ao ID e à versão vistos, inclusive em exclusões de vários itens.
    const labels = waiting.map((command) => {
      const field =
        command.op === 'finance_delete'
          ? 'entry'
          : command.op === 'finance_plan_delete'
            ? 'planItem'
            : 'template';
      const candidates =
        field === 'entry'
          ? f.entries.map((x) => ({ ...x, label: x.description, name: x.description }))
          : field === 'template'
            ? f.templates.map((x) => ({ ...x, label: `modelo ${x.name}` }))
            : (f.plan ?? [])
                .filter((x) => !command.planKind || x.kind === command.planKind)
                .map((x) => ({
                  ...x,
                  name: planName(x),
                  label: `${planKindLabel[x.kind]} ${planName(x)}`,
                }));
      const matches = candidates.filter(
        (x) =>
          x.id === command[field] ||
          (command[field] && normalize(x.name) === normalize(command[field]!)),
      );
      if (matches.length !== 1) return command[field] ?? 'item';
      const item = matches[0];
      command[field] = item.id;
      command.expectedVersion ??= item.version;
      return `${item.label}, ${money(item.amountCents)}`;
    });
    throw new Ambiguity(
      waiting.length > 1
        ? `Excluir estes ${waiting.length} ${waiting.every((x) => x.op === 'finance_delete') ? 'lançamentos' : 'itens'}?\n${labels.map((label) => `- ${label}`).join('\n')}`
        : `Excluir ${labels[0]}?`,
      'confirmed',
      [
        { ref: 'true', label: 'Sim, excluir', keywords: ['sim', 'excluir'] },
        { ref: 'false', label: 'Cancelar', keywords: ['nao', 'cancelar'] },
      ],
    );
  };
  const entry = (): FinanceEntry => {
    const matches = f.entries.filter(
      (x) => x.id === c.entry || (c.entry && normalize(x.description) === normalize(c.entry)),
    );
    if (matches.length !== 1)
      throw new Ambiguity(
        'Qual lançamento deseja alterar?',
        'entry',
        matches.slice(0, 20).map((x) => ({
          ref: x.id,
          label: `${x.description} — ${money(x.amountCents)} — ${x.date}`,
        })),
      );
    checkVersion(matches[0].version);
    return matches[0];
  };
  let reply = '';
  if (c.op === 'finance_plan_list') {
    const plan = f.plan ?? [];
    const month = c.month ?? localDate(now).slice(0, 7);
    const { fromDate, toDate } = monthRange(month);
    const entries = entriesInPeriod(f.entries, fromDate, toDate);
    const totals = entryTotals(entries);
    const summary = planSummary(plan, {
      ...totals,
      byCategory: groupedTotals(entries, 'categoryId'),
    });
    const selected = plan
      .filter((x) => !c.planKind || x.kind === c.planKind)
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          planName(a).localeCompare(planName(b)) ||
          a.id.localeCompare(b.id),
      );
    const rows = financePage(selected, c.page).map((x) => {
      const budget = summary.budgetRows.find((row) => row.categoryId === x.categoryId);
      const progress =
        x.kind === 'budget' && budget
          ? ` — realizado ${money(budget.spent)} (${budget.percent}%; ${budget.state === 'over' ? 'acima do limite' : budget.state === 'warning' ? 'perto do limite' : 'dentro do limite'})`
          : '';
      return `${planKindLabel[x.kind]} — ${planName(x)} — ${money(x.amountCents)}/mês${progress}`;
    });
    return {
      changed: false,
      reply: `Planejamento mensal: renda prevista ${money(summary.income)}; gastos fixos ${money(summary.fixed)}; livre para gastar ${money(summary.free)}.\nRealizado em ${month}: receitas ${money(totals.income)}; despesas ${money(totals.expense)}. Despesa planejada ${money(summary.plannedExpense)}.\n${selected.length} item(ns). ${pageHint(selected.length, c.page)}\n${rows.join('\n') || 'Nenhum item nesta página.'}`,
    };
  }
  if (c.op === 'finance_plan_update' || c.op === 'finance_plan_delete') {
    const item = select(
      (f.plan ?? []).filter((x) => !c.planKind || x.kind === c.planKind),
      c.planItem,
      'planItem',
      'Qual item do planejamento deseja alterar?',
      planName,
      (x) => `${planKindLabel[x.kind]} — ${planName(x)} — ${money(x.amountCents)}/mês`,
    );
    if (c.op === 'finance_plan_delete') {
      if (channel !== 'panel') confirmDeletion();
      f.plan = f.plan!.filter((x) => x.id !== item.id);
      reply = `${planKindLabel[item.kind]} ${planName(item)} excluído do planejamento.`;
    } else {
      const updated = prepareFinancePlanItem(
        {
          id: item.id,
          kind: item.kind,
          name: c.name ?? item.name,
          amount: c.amount ?? amountText(item.amountCents),
          categoryId:
            c.category === undefined
              ? item.categoryId
              : c.category === null
                ? null
                : category(c.category, 'expense').id,
          expectedVersion: c.expectedVersion,
        },
        f.plan!,
        f.categories,
        at,
      );
      f.plan = f.plan!.map((x) => (x.id === item.id ? updated : x));
      reply = `Planejamento atualizado: ${planKindLabel[updated.kind]} — ${planName(updated)} — ${money(updated.amountCents)}/mês.`;
    }
    state.history.push({ id: randomUUID(), taskId: 0, action: reply, source: channel, at });
    return { changed: true, reply };
  }
  if (c.op === 'finance_plan_create') {
    if (!c.planKind)
      throw new Ambiguity(
        'Qual tipo de item deseja adicionar ao planejamento?',
        'planKind',
        Object.entries(planKindLabel).map(([ref, label]) => ({ ref, label })),
      );
    if (c.planKind !== 'budget' && !c.name)
      throw new Ambiguity('Qual é o nome deste item do planejamento?', 'name', []);
    if (c.amount === undefined)
      throw new Ambiguity('Qual é o valor mensal deste item do planejamento?', 'amount', []);
    if (c.planKind === 'budget' && !c.category)
      throw new Ambiguity(
        'Qual categoria de despesa terá esse limite mensal?',
        'category',
        f.categories
          .filter((x) => !x.archivedAt && x.kind !== 'income')
          .map((x) => ({ ref: x.id, label: x.name })),
      );
    // Num lote, um nome repetido não derruba os demais: o item que já existe é mantido e a
    // resposta diz o valor dele, para a pessoa pedir a troca se quiser.
    const same =
      c.planKind !== 'budget'
        ? (f.plan ?? []).find(
            (x) => x.kind === c.planKind && normalize(x.name) === normalize(c.name!),
          )
        : undefined;
    if (same) {
      const asked = parseMoney(c.amount);
      reply =
        asked === same.amountCents
          ? `${same.name} já estava no planejamento (${money(same.amountCents)}/mês); não repeti.`
          : `${same.name} já está no planejamento com ${money(same.amountCents)}/mês (você pediu ${money(asked)}); mantive o atual. Para trocar, peça “altere ${same.name} para ${money(asked)}”.`;
      return { changed: false, reply };
    }
    const item = prepareFinancePlanItem(
      {
        kind: c.planKind,
        name: c.name,
        amount: c.amount,
        categoryId:
          c.planKind !== 'income' && c.category ? category(c.category, 'expense').id : null,
      },
      f.plan ?? [],
      f.categories,
      at,
    );
    (f.plan ??= []).push(item);
    reply = `${planKindLabel[item.kind]} ${item.kind === 'income' ? 'adicionada' : 'adicionado'} ao planejamento: ${item.name || category(item.categoryId!).name} — ${money(item.amountCents)}/mês.`;
    state.history.push({ id: randomUUID(), taskId: 0, action: reply, source: channel, at });
    return { changed: true, reply };
  }
  if (c.op === 'finance_summary') {
    const period = reportPeriod(c, now);
    const cat = c.category ? category(c.category).id : undefined;
    const eligible = f.entries.filter(
      (x) => (!c.kind || x.kind === c.kind) && (!cat || x.categoryId === cat),
    );
    const entries = entriesInPeriod(eligible, period.fromDate, period.toDate);
    const totals = entryTotals(entries);
    const previous = entryTotals(
      entriesInPeriod(eligible, period.previous.fromDate, period.previous.toDate),
    );
    const groups = groupedTotals(entries, c.breakdown === 'day' ? 'date' : 'categoryId');
    const rows = financePage(groups, c.page).map(
      (x) =>
        `${c.breakdown === 'day' ? x.id : category(x.id).name} — receitas ${money(x.income)}; despesas ${money(x.expense)}`,
    );
    const variation = previous.expense
      ? ` Variação das despesas: ${((totals.expense / previous.expense - 1) * 100).toFixed(1).replace('.', ',')}%.`
      : ' Sem base de despesas para comparação percentual.';
    return {
      changed: false,
      reply: `Resumo financeiro de ${period.fromDate} a ${period.toDate}: receitas ${money(totals.income)}; despesas ${money(totals.expense)}; resultado ${money(totals.result)}.\nMês anterior (${period.previous.fromDate.slice(0, 7)}): receitas ${money(previous.income)}; despesas ${money(previous.expense)}; resultado ${money(previous.result)}.${variation}\nPor ${c.breakdown === 'day' ? 'dia' : 'categoria'}. ${pageHint(groups.length, c.page)}\n${rows.join('\n') || 'Nenhum lançamento nesta página.'}`,
    };
  }
  if (c.op === 'finance_list_categories') {
    const selected = f.categories
      .filter(
        (x) =>
          (c.archived === undefined || Boolean(x.archivedAt) === c.archived) &&
          (!c.categoryKind || x.kind === c.categoryKind || x.kind === 'both'),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      changed: false,
      reply: `${selected.length} categoria(s). ${pageHint(selected.length, c.page)}\n${
        financePage(selected, c.page)
          .map((x) => `${x.name} — ${kindLabel(x.kind)}${x.archivedAt ? ' — arquivada' : ''}`)
          .join('\n') || 'Nenhuma categoria nesta página.'
      }`,
    };
  }
  if (c.op === 'finance_list_templates') {
    const selected = f.templates
      .filter((x) => !c.kind || x.kind === c.kind)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      changed: false,
      reply: `${selected.length} modelo(s) de lançamento. ${pageHint(selected.length, c.page)}\n${
        financePage(selected, c.page)
          .map(
            (x) =>
              `${x.name} — ${kindLabel(x.kind)} — ${money(x.amountCents)} — ${category(x.categoryId).name}`,
          )
          .join('\n') || 'Nenhum modelo nesta página.'
      }`,
    };
  }
  if (c.op === 'finance_list') {
    if (c.fromDate && c.toDate && c.fromDate > c.toDate) throw new DomainError('Período inválido.');
    const cat = c.category ? category(c.category).id : undefined;
    const entries = f.entries.filter(
      (x) =>
        Boolean(x.deletedAt) === (c.deleted ?? false) &&
        (!c.kind || x.kind === c.kind) &&
        (!cat || x.categoryId === cat) &&
        (!c.fromDate || x.date >= c.fromDate) &&
        (!c.toDate || x.date <= c.toDate) &&
        (!c.search || normalize(x.description).includes(normalize(c.search))),
    );
    const { income, expense } = entryTotals(entries);
    const page = c.page ?? 1;
    return {
      changed: false,
      reply: `${c.deleted ? 'Lançamentos excluídos — os valores abaixo não entram no saldo realizado.\n' : ''}Receitas: ${money(income)}. Despesas: ${money(expense)}. Resultado do período: ${money(income - expense)}.\n${entries.length} lançamento(s). ${pageHint(entries.length, page)}\n${entries
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
        .slice((page - 1) * 10, page * 10)
        .map(
          (x) =>
            `${x.description} — ${money(x.amountCents)} — ${x.date} — ${f.categories.find((cat) => cat.id === x.categoryId)?.name}`,
        )
        .join('\n')}`,
    };
  }
  // Usar um modelo copia seus dados atuais para um lançamento; editar o modelo nunca altera
  // o que já foi lançado, nem cria lançamentos automaticamente.
  if (c.op.endsWith('_template')) {
    const template = () =>
      select(
        f.templates,
        c.template,
        'template',
        'Qual modelo de lançamento deseja usar ou alterar?',
        (x) => x.name,
        (x) => `${x.name} — ${money(x.amountCents)}`,
      );
    if (c.op === 'finance_use_template') {
      const item = template();
      return financeCommand(
        state,
        {
          op: 'finance_create',
          kind: c.kind ?? item.kind,
          amount: c.amount ?? amountText(item.amountCents),
          description: c.description ?? item.description,
          category: c.category === undefined ? item.categoryId : c.category,
          date: c.date,
        },
        channel,
        now,
        batch,
      );
    }
    if (c.op === 'finance_create_template') {
      if (!c.name?.trim())
        throw new Ambiguity('Qual é o nome do modelo de lançamento?', 'name', []);
      if (f.templates.some((x) => normalize(x.name) === normalize(c.name!)))
        throw new DomainError('Já existe um modelo com esse nome.');
      const kind = required(c.kind, 'kind');
      const cat = category(c.category, kind);
      if (cat.archivedAt) throw new DomainError('Escolha uma categoria ativa.');
      const description = (c.description ?? c.name).trim();
      if (!description) throw new DomainError('Informe a descrição.');
      f.templates.push({
        id: randomUUID(),
        name: c.name.trim(),
        kind,
        amountCents: parseMoney(required(c.amount, 'amount')),
        description,
        categoryId: cat.id,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      reply = `Modelo ${c.name.trim()} salvo.`;
    } else if (c.op === 'finance_delete_template') {
      const item = template();
      if (channel !== 'panel') confirmDeletion();
      f.templates = f.templates.filter((x) => x.id !== item.id);
      reply = `Modelo ${item.name} excluído.`;
    } else {
      const item = template();
      const kind = c.kind ?? item.kind;
      const cat = category(c.category ?? item.categoryId, kind);
      if (cat.archivedAt && cat.id !== item.categoryId)
        throw new DomainError('Escolha uma categoria ativa.');
      if (
        c.name &&
        f.templates.some((x) => x.id !== item.id && normalize(x.name) === normalize(c.name!))
      )
        throw new DomainError('Já existe um modelo com esse nome.');
      if (c.name) item.name = c.name.trim();
      item.kind = kind;
      item.categoryId = cat.id;
      if (c.amount !== undefined) item.amountCents = parseMoney(c.amount);
      if (c.description !== undefined) {
        if (!c.description.trim()) throw new DomainError('Informe a descrição.');
        item.description = c.description.trim();
      }
      item.version++;
      item.updatedAt = at;
      reply = `Modelo ${item.name} atualizado.`;
    }
    state.history.push({ id: randomUUID(), taskId: 0, action: reply, source: channel, at });
    return { changed: true, reply };
  }
  if (c.op === 'finance_create_category') {
    if (!c.name) throw new DomainError('Informe o nome da categoria.');
    if (f.categories.some((x) => normalize(x.name) === normalize(c.name!)))
      throw new DomainError('Já existe uma categoria com esse nome.');
    // Pela conversa o tipo costuma ficar implícito (“crie a categoria besteiras”). Despesa é o
    // caso comum e a resposta diz qual tipo foi criado, para a correção ser imediata.
    const kind = c.categoryKind ?? 'expense';
    f.categories.push({
      id: randomUUID(),
      name: c.name,
      kind,
      archivedAt: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    reply = `Categoria ${c.name} criada para ${kindLabel(kind)}.`;
  } else if (
    ['finance_update_category', 'finance_archive_category', 'finance_restore_category'].includes(
      c.op,
    )
  ) {
    // Sem `category`, a busca cairia no apelido padrão “sem categoria” e arquivaria justamente
    // a categoria que segura os lançamentos sem classificação.
    if (!c.category) throw new DomainError('Informe qual categoria deseja alterar.');
    const item = category(c.category);
    checkVersion(item.version);
    if (c.op === 'finance_update_category') {
      if (
        c.name &&
        f.categories.some((x) => x.id !== item.id && normalize(x.name) === normalize(c.name!))
      )
        throw new DomainError('Já existe uma categoria com esse nome.');
      if (
        c.categoryKind &&
        c.categoryKind !== 'both' &&
        (f.entries.some((x) => x.categoryId === item.id && x.kind !== c.categoryKind) ||
          f.templates.some((x) => x.categoryId === item.id && x.kind !== c.categoryKind) ||
          (c.categoryKind === 'income' && (f.plan ?? []).some((x) => x.categoryId === item.id)))
      )
        throw new DomainError(
          'Há lançamentos, modelos ou itens do planejamento incompatíveis com esse tipo.',
        );
      if (c.name) item.name = c.name;
      if (c.categoryKind) item.kind = c.categoryKind;
    } else item.archivedAt = c.op === 'finance_archive_category' ? at : null;
    item.version++;
    item.updatedAt = at;
    reply = `Categoria ${item.name} ${item.archivedAt ? 'arquivada' : c.op === 'finance_restore_category' ? 'reativada' : 'atualizada'}.`;
  } else if (c.op === 'finance_create') {
    const kind = required(c.kind, 'kind');
    const amountCents = parseMoney(required(c.amount, 'amount'));
    const description = required(c.description, 'description').trim();
    if (!description) throw new DomainError('Informe a descrição.');
    const cat = category(c.category, kind);
    if (cat.archivedAt) throw new DomainError('Escolha uma categoria ativa.');
    const item: FinanceEntry = {
      id: randomUUID(),
      kind,
      amountCents,
      description,
      categoryId: cat.id,
      date: c.date ?? localDate(now),
      version: 1,
      source: channel === 'web' ? 'web' : 'panel',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    f.entries.push(item);
    reply = `${kind === 'income' ? 'Receita' : 'Despesa'} registrada: ${money(amountCents)} — ${item.date} — ${cat.name} — ${description}.`;
  } else if (['finance_update', 'finance_delete', 'finance_restore'].includes(c.op)) {
    const item = entry();
    // Excluído só sai da lixeira restaurado, e restaurar o que está ativo não muda nada: nos
    // dois casos a resposta avisa sem gravar versão nem histórico.
    if (c.op === 'finance_delete' && item.deletedAt)
      return { changed: false, reply: `${item.description} já está entre os excluídos.` };
    if (c.op === 'finance_restore' && !item.deletedAt)
      return { changed: false, reply: `${item.description} já está ativo.` };
    if (c.op === 'finance_delete') {
      confirmDeletion();
      item.deletedAt = at;
    } else if (c.op === 'finance_restore') item.deletedAt = null;
    else {
      if (item.deletedAt) throw new DomainError('Restaure o lançamento antes de editar.');
      const kind = c.kind ?? item.kind;
      const cat = category(c.category ?? item.categoryId, kind);
      if (cat.archivedAt && cat.id !== item.categoryId)
        throw new DomainError('Escolha uma categoria ativa.');
      item.kind = kind;
      item.categoryId = cat.id;
      if (c.amount !== undefined) item.amountCents = parseMoney(c.amount);
      if (c.description !== undefined) {
        if (!c.description.trim()) throw new DomainError('Informe a descrição.');
        item.description = c.description.trim();
      }
      if (c.date) item.date = c.date;
    }
    item.version++;
    item.updatedAt = at;
    reply = `${item.description}: ${c.op === 'finance_delete' ? 'excluído (restaure pelo Financeiro)' : c.op === 'finance_restore' ? 'restaurado' : 'atualizado'} — ${money(item.amountCents)} — ${item.date} — ${category(item.categoryId).name}.`;
  } else throw new DomainError('Operação financeira inválida.');
  state.history.push({ id: randomUUID(), taskId: 0, action: reply, source: channel, at });
  return { changed: true, reply };
}
