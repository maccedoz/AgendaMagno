import { randomUUID } from 'node:crypto';
import { Ambiguity, DomainError, type Command, type State } from '../domain/types';
import { localDate, normalize } from '../domain/format';
import { MAX_CENTS, type FinanceCategory, type FinanceEntry } from './types';
export const money = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
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
export const isFinance = (c: Command) => c.op.startsWith('finance_');
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
  const category = (ref: string | undefined, kind?: string): FinanceCategory => {
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
  if (c.op === 'finance_list') {
    if (c.fromDate && c.toDate && c.fromDate > c.toDate) throw new DomainError('Período inválido.');
    const cat = c.category ? category(c.category).id : undefined;
    const entries = f.entries.filter(
      (x) =>
        !x.deletedAt &&
        (!c.kind || x.kind === c.kind) &&
        (!cat || x.categoryId === cat) &&
        (!c.fromDate || x.date >= c.fromDate) &&
        (!c.toDate || x.date <= c.toDate) &&
        (!c.search || normalize(x.description).includes(normalize(c.search))),
    );
    const income = entries
      .filter((x) => x.kind === 'income')
      .reduce((s, x) => s + x.amountCents, 0);
    const expense = entries
      .filter((x) => x.kind === 'expense')
      .reduce((s, x) => s + x.amountCents, 0);
    const page = c.page ?? 1;
    return {
      changed: false,
      reply: `Receitas: ${money(income)}. Despesas: ${money(expense)}. Resultado do período: ${money(income - expense)}.\n${entries.length} lançamento(s). Página ${page}.\n${entries
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice((page - 1) * 10, page * 10)
        .map(
          (x) =>
            `${x.description} — ${money(x.amountCents)} — ${x.date} — ${f.categories.find((cat) => cat.id === x.categoryId)?.name}`,
        )
        .join('\n')}`,
    };
  }
  // Modelos de lançamento: só pelo painel. A conversa registra lançamentos direto, então não
  // ganha nada em criar atalhos, e o schema fica menor para o modelo errar menos.
  if (c.op.endsWith('_template')) {
    const template = () => {
      const matches = f.templates.filter(
        (x) => x.id === c.template || (c.template && normalize(x.name) === normalize(c.template)),
      );
      if (matches.length !== 1) throw new DomainError('Modelo não encontrado.');
      if (c.expectedVersion !== undefined && c.expectedVersion !== matches[0].version)
        throw new DomainError('Este modelo foi alterado. Atualize antes de salvar.', 409);
      return matches[0];
    };
    if (c.op === 'finance_create_template') {
      if (!c.name?.trim()) throw new DomainError('Informe o nome do modelo.');
      if (f.templates.some((x) => normalize(x.name) === normalize(c.name!)))
        throw new DomainError('Já existe um modelo com esse nome.');
      const kind = required(c.kind, 'kind');
      const cat = category(c.category, kind);
      if (cat.archivedAt) throw new DomainError('Escolha uma categoria ativa.');
      const description = required(c.description, 'description').trim();
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
        f.entries.some((x) => x.categoryId === item.id && x.kind !== c.categoryKind)
      )
        throw new DomainError('Há lançamentos incompatíveis com esse tipo.');
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
      // Um pedido como "apague os lançamentos do mercado" traz várias exclusões. A confirmação
      // é uma só para o pedido inteiro: perguntar item por item obrigava a responder "sim" a
      // cada lançamento, e o "sim" dado vale para todos (ver applyChoice).
      const waiting = batch.filter((x) => x.op === 'finance_delete' && !x.confirmed);
      const label = (ref: string | undefined) => {
        const found = f.entries.filter(
          (x) => x.id === ref || (ref && normalize(x.description) === normalize(ref)),
        );
        return found.length === 1
          ? `${found[0].description}, ${money(found[0].amountCents)}`
          : (ref ?? 'lançamento');
      };
      if (!c.confirmed)
        throw new Ambiguity(
          waiting.length > 1
            ? `Excluir estes ${waiting.length} lançamentos?\n${waiting.map((x) => `- ${label(x.entry)}`).join('\n')}`
            : `Excluir ${item.description}, ${money(item.amountCents)}?`,
          'confirmed',
          [
            { ref: 'true', label: 'Sim, excluir', keywords: ['sim', 'excluir'] },
            { ref: 'false', label: 'Cancelar', keywords: ['nao', 'cancelar'] },
          ],
        );
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
