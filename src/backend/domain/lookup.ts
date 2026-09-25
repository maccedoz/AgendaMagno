import { normalize, localDate, isOverdue } from './format';
import {
  Ambiguity,
  DomainError,
  type Command,
  type Conversation,
  type Group,
  type State,
  type Task,
} from './types';

export function contextFor(state: State, channel: string, now: Date): Conversation {
  const existing = state.conversations.find((c) => c.id === channel);
  if (existing && existing.expiresAt > now.toISOString()) return existing;
  const ctx: Conversation = {
    id: channel,
    groupId: null,
    taskIds: [],
    expiresAt: new Date(now.getTime() + 30 * 60000).toISOString(),
  };
  state.conversations = [...state.conversations.filter((c) => c.id !== channel), ctx];
  return ctx;
}
export function findGroup(
  state: State,
  ref: string | null | undefined,
  ctx: Conversation,
): Group | null {
  if (ref == null || normalize(ref) === 'caixa de entrada') return null;
  if (['nesse grupo', 'neste grupo', 'esse grupo', 'contexto'].includes(normalize(ref))) {
    if (!ctx.groupId) throw new DomainError('Qual grupo você quer usar? Informe o nome.');
    ref = ctx.groupId;
  }
  const exact = state.groups.filter((g) => g.id === ref || normalize(g.name) === normalize(ref!));
  const matches = exact.length
    ? exact
    : state.groups.filter((g) => normalize(g.name).includes(normalize(ref!)));
  if (!matches.length)
    throw new Ambiguity(
      `O grupo “${ref}” não existe. Responda “criar” para criá-lo e continuar, ou envie um novo comando.`,
      'group',
      [],
      ref,
    );
  if (matches.length > 1)
    throw new Ambiguity(
      'Encontrei mais de um grupo. Responda com o número da opção:',
      'group',
      matches.map((g) => ({ ref: g.id, label: g.name })),
    );
  ctx.groupId = matches[0].id;
  return matches[0];
}
export function findTask(state: State, command: Command, ctx: Conversation): Task {
  let ref = command.task;
  if (!ref)
    throw new Ambiguity(
      'Qual tarefa você quer alterar? Informe o título ou o código da tarefa.',
      'task',
      ctx.taskIds
        .map((id) => state.tasks.find((t) => t.id === id))
        .filter((t): t is Task => Boolean(t))
        .map((t) => ({ ref: `#${t.id}`, label: `#${t.id} ${t.title}` })),
    );
  if (['essa tarefa', 'esta tarefa', 'contexto'].includes(normalize(ref))) {
    if (ctx.taskIds.length !== 1)
      throw new DomainError('Qual tarefa? Informe o código, por exemplo #12.');
    ref = `#${ctx.taskIds[0]}`;
  }
  const ordinal = normalize(ref).match(/^(?:a )?(primeira|segunda|terceira|quarta|quinta)$/);
  if (ordinal) {
    const idx = ['primeira', 'segunda', 'terceira', 'quarta', 'quinta'].indexOf(ordinal[1]);
    if (!ctx.taskIds[idx])
      throw new DomainError('Essa posição não está na última lista. Informe o código da tarefa.');
    ref = `#${ctx.taskIds[idx]}`;
  }
  let scope = state.tasks;
  if (command.group !== undefined && command.op !== 'update_task') {
    const g = findGroup(state, command.group, ctx);
    scope = scope.filter((t) => t.groupId === (g?.id ?? null));
  }
  const numeric = ref.match(/^#?(\d+)$/);
  let matches = numeric
    ? scope.filter((t) => t.id === Number(numeric[1]))
    : scope.filter((t) => normalize(t.title) === normalize(ref!));
  if (!matches.length && !numeric)
    matches = scope.filter((t) => normalize(t.title).includes(normalize(ref!)));
  if (!matches.length)
    throw new DomainError('Não encontrei essa tarefa. Ela pode ter sido excluída definitivamente.');
  if (matches.length > 1)
    throw new Ambiguity(
      'Encontrei tarefas com nomes parecidos. Responda com o número da opção:',
      'task',
      matches.slice(0, 20).map((t) => ({
        ref: `#${t.id}`,
        label: `#${t.id} ${t.title} — ${state.groups.find((g) => g.id === t.groupId)?.name ?? 'Caixa de entrada'}${t.trashedAt ? ' (lixeira)' : ''}`,
      })),
    );
  if (command.expectedVersion !== undefined && command.expectedVersion !== matches[0].version)
    throw new DomainError('A tarefa foi alterada em outra tela. Atualize antes de salvar.', 409);
  ctx.taskIds = [matches[0].id];
  return matches[0];
}
export function selectTasks(
  state: State,
  command: Command,
  now: Date,
  groupId?: string | null,
): Task[] {
  return state.tasks
    .filter((t) => {
      const filter = command.filter ?? 'active';
      if (filter === 'trash') {
        if (!t.trashedAt) return false;
      } else if (filter === 'completed') {
        if (t.trashedAt || t.status !== 'completed') return false;
      } else if (filter !== 'all' && t.trashedAt) return false;
      if (!['all', 'trash', 'completed'].includes(filter) && t.status === 'completed') return false;
      if (
        groupId === undefined &&
        filter !== 'all' &&
        state.groups.some((g) => g.id === t.groupId && g.archivedAt)
      )
        return false;
      if (command.dueDate !== undefined && t.dueDate !== command.dueDate) return false;
      if (command.fromDate && (!t.dueDate || t.dueDate < command.fromDate)) return false;
      if (command.toDate && (!t.dueDate || t.dueDate > command.toDate)) return false;
      if (command.tag && !t.tags?.some((tag) => normalize(tag) === normalize(command.tag!)))
        return false;
      if (filter === 'today' && t.dueDate !== localDate(now)) return false;
      if (filter === 'overdue' && !isOverdue(t, now)) return false;
      if (filter === 'no_date' && t.dueDate) return false;
      if (groupId !== undefined && t.groupId !== groupId) return false;
      if (
        command.search &&
        !normalize(`${t.title} ${t.description}`).includes(normalize(command.search))
      )
        return false;
      return true;
    })
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.id - a.id);
}
