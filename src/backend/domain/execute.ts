import { financeCommand, isFinance } from '../finance/rules';
import { randomUUID } from 'node:crypto';
import { formatWeekSummary, resolveWeek, weekSummary } from '../summary';
import { nextDue } from './recurrence';
import { dueLabel, formatDate, normalize } from './format';
import { contextFor, findGroup, findTask, selectTasks } from './lookup';
import {
  Ambiguity,
  DomainError,
  panelCommandsSchema,
  type Conversation,
  type Group,
  type Command,
  type PendingOption,
  type State,
  type Task,
} from './types';

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new DomainError(`Informe ${label}.`);
  return value;
}
function trash(t: Task, state: State, now: Date, completed: boolean) {
  if (!t.trashedAt) {
    t.trashedAt = now.toISOString();
    t.purgeAt = new Date(now.getTime() + state.settings.retentionDays * 86400000).toISOString();
  }
  t.trashReason = completed ? 'completed' : 'discarded';
  if (completed) {
    t.status = 'completed';
    t.completedAt ??= now.toISOString();
  }
}
function validateSchedule(t: Task) {
  if (t.recurrence && !t.dueDate) throw new DomainError('Defina uma data para a recorrência.');
  if (t.reminderMinutes != null && !t.dueDate)
    throw new DomainError('Defina uma data para o lembrete.');
  if (t.recurrence?.frequency === 'monthly' && !t.recurrence.monthDay)
    t.recurrence.monthDay = Number(t.dueDate!.slice(8));
  if (t.tags) t.tags = [...new Set(t.tags)];
  if (t.checklist && new Set(t.checklist.map((item) => item.id)).size !== t.checklist.length)
    throw new DomainError('Itens do checklist devem ter identificadores diferentes.');
}
// Resposta única para pedidos fora do catálogo de operações. Exportada porque a reescrita em
// linguagem natural é pulada quando a resposta começa por ela: a recusa precisa chegar com
// estas palavras, sem passar por um modelo que poderia suavizá-la.
export const UNSUPPORTED = 'Não consigo fazer isso ainda.';
export const HELP =
  'Você pode criar grupos e tarefas, editar, concluir, restaurar e consultar. Exemplos:\n• Crie um grupo chamado Estudos\n• Adicione ler capítulo 3 em Estudos\n• Anota: comprar pilhas\n• Finalizei #1\n• Restaure #1\n• O que vence hoje?\n• Quais tarefas estão na lixeira?\n• Exclua as tarefas da lixeira depois de 15 dias\n• Desfaça a última alteração\n• Resumo da semana (ou “como foi minha semana?”)\nUse o microfone do chat para ditar, revisar e enviar texto (não recebe arquivos de áudio). Com IA, registre receitas/despesas, categorias e consultas financeiras, por exemplo “Gastei 42,90 no almoço hoje”. O Financeiro também funciona por formulário. Para descrições e campos, use também o painel. Com uma IA cadastrada em Modelos de IA, você escreve do seu jeito, sem seguir esses formatos.';

export function execute(
  original: State,
  input: unknown,
  channel = 'panel',
  now = new Date(),
): { state: State; reply: string; clarification: boolean } {
  const commands = panelCommandsSchema.parse(input);
  if (
    commands.some((c) => ['undo', 'clarify', 'unsupported'].includes(c.op)) &&
    commands.length > 1
  )
    throw new DomainError('Envie esse pedido separadamente para evitar alterações parciais.');
  const state = structuredClone(original);
  const ctx = contextFor(state, channel, now);
  delete ctx.pending;
  ctx.expiresAt = new Date(now.getTime() + 30 * 60000).toISOString();
  const replies: string[] = [];
  const touched = new Map<number, Task | null>();
  const groupChanges = new Map<string, Group | null>();
  const touchGroup = (id: string) => {
    if (!groupChanges.has(id))
      groupChanges.set(id, structuredClone(original.groups.find((g) => g.id === id) ?? null));
    const group = state.groups.find((g) => g.id === id);
    if (group) group.version = (group.version ?? 0) + 1;
    mutation = true;
  };
  let barrier = false;
  let mutation = false;
  let commandIndex = 0;
  const touch = (t: Task, action: string) => {
    if (!touched.has(t.id))
      touched.set(t.id, structuredClone(original.tasks.find((old) => old.id === t.id) ?? null));
    t.version++;
    t.updatedAt = now.toISOString();
    state.history.push({
      id: randomUUID(),
      taskId: t.id,
      action,
      source: channel,
      at: now.toISOString(),
    });
    mutation = true;
  };
  try {
    for (const c of commands) {
      if (isFinance(c)) {
        const result = financeCommand(state, c, channel, now, commands);
        replies.push(result.reply);
        if (result.changed) mutation = barrier = true;
        commandIndex++;
        continue;
      }
      switch (c.op) {
        case 'help':
          replies.push(HELP);
          break;
        case 'clarify':
          replies.push(c.question ?? 'Pode explicar qual tarefa e alteração você quer fazer?');
          break;
        // Resposta única para tudo o que a agenda não sabe fazer. Sem ela, um pedido fora do
        // catálogo virava uma pergunta de esclarecimento, e a pessoa reformulava a frase várias
        // vezes tentando acertar uma operação que simplesmente não existe.
        case 'unsupported':
          replies.push(`${UNSUPPORTED}${c.question ? ` ${c.question}` : ''}`);
          break;
        case 'settings':
          replies.push(
            `A lixeira exclui tarefas após ${state.settings.retentionDays} dias. Alterações no prazo valem para novas entradas. Resposta em linguagem natural: ${state.settings.naturalReply === false ? 'desligada' : 'ligada'}.`,
          );
          break;
        case 'week_summary': {
          if (!state.finance)
            throw new DomainError('Dados financeiros indisponíveis. Atualize e tente novamente.');
          const start = resolveWeek(c.date ? { week: c.date } : {}, now);
          replies.push(formatWeekSummary(weekSummary(state, state.finance, start, now)));
          break;
        }
        case 'set_natural_reply':
          state.settings.naturalReply = requireValue(c.enabled, 'ligada ou desligada');
          mutation = barrier = true;
          replies.push(
            c.enabled
              ? 'Respostas em linguagem natural ligadas. Cada mensagem passa por uma segunda chamada à IA, que conta nos limites diários.'
              : 'Respostas em linguagem natural desligadas. As respostas voltam ao formato direto, sem chamada extra à IA.',
          );
          break;
        case 'set_retention':
          state.settings.retentionDays = requireValue(c.days, 'a quantidade de dias');
          mutation = barrier = true;
          replies.push(
            `Lixeira configurada para ${c.days} dias. Vale para novas entradas; as tarefas já na lixeira mantêm suas datas.`,
          );
          break;
        case 'create_group': {
          const name = requireValue(c.name, 'o nome do grupo');
          if (state.groups.some((g) => normalize(g.name) === normalize(name)))
            throw new DomainError('Já existe um grupo com esse nome.');
          const group = {
            id: randomUUID(),
            name,
            createdAt: now.toISOString(),
            color: c.color ?? 'sage',
            icon: c.icon ?? 'folder',
            order: c.order ?? state.groups.length,
            archivedAt: null,
            version: 0,
          };
          state.groups.push(group);
          ctx.groupId = group.id;
          touchGroup(group.id);
          replies.push(`Grupo ${name} criado.`);
          break;
        }
        case 'rename_group':
        case 'update_group':
        case 'archive_group':
        case 'restore_group':
        case 'delete_group': {
          const group = findGroup(state, requireValue(c.group ?? undefined, 'o grupo'), ctx);
          if (!group) throw new DomainError('A Caixa de entrada não pode ser alterada.');
          if (c.expectedVersion !== undefined && c.expectedVersion !== (group.version ?? 0))
            throw new DomainError(
              'O grupo foi alterado em outra tela. Atualize antes de salvar.',
              409,
            );
          // Erro aqui encerrava o pedido: a pessoa recebia a exigência e tinha de reescrever a
          // frase inteira com a escolha. Como pergunta pendente, a resposta seguinte retoma a
          // exclusão de onde parou.
          if (c.op === 'delete_group' && c.deleteTasks === undefined) {
            // Vários grupos no mesmo pedido recebem uma pergunta só, e a resposta vale para
            // todos os que ainda não disseram o que fazer com as tarefas (ver applyChoice).
            const others = commands
              .filter((x) => x.op === 'delete_group' && x.deleteTasks === undefined && x !== c)
              .map((x) => findGroupQuiet(state, x.group, ctx))
              .filter((g): g is Group => Boolean(g) && g!.id !== group.id);
            const count = (g: Group) => state.tasks.filter((t) => t.groupId === g.id).length;
            throw new Ambiguity(
              others.length
                ? `Os grupos ${[group, ...others].map((g) => `${g.name} (${count(g)} tarefa(s))`).join(', ')} serão excluídos. O que fazer com as tarefas deles? Responda com o número da opção:`
                : `O grupo ${group.name} tem ${count(group)} tarefa(s). O que fazer com elas? Responda com o número da opção:`,
              'deleteTasks',
              [
                {
                  ref: 'false',
                  label: 'Manter as tarefas, movendo-as para a Caixa de entrada',
                  keywords: [
                    'manter',
                    'mantenha',
                    'preservar',
                    'preserve',
                    'guardar',
                    'caixa de entrada',
                    'so o grupo',
                    'somente o grupo',
                    'apenas o grupo',
                    'nao',
                  ],
                },
                {
                  ref: 'true',
                  label: 'Enviar as tarefas para a lixeira junto com o grupo',
                  keywords: [
                    'excluir',
                    'excluidas',
                    'excluida',
                    'excluir tambem',
                    'apagar',
                    'apagadas',
                    'deletar',
                    'lixeira',
                    'junto',
                    'tudo',
                    'ambos',
                    'sim',
                  ],
                },
              ],
            );
          }
          touchGroup(group.id);
          if (c.op === 'delete_group') {
            let count = 0;
            for (const task of state.tasks.filter((t) => t.groupId === group.id)) {
              task.groupId = null;
              if (c.deleteTasks && !task.trashedAt) trash(task, state, now, false);
              touch(
                task,
                c.deleteTasks
                  ? 'Grupo excluído; tarefa enviada à lixeira'
                  : 'Grupo excluído; tarefa desvinculada',
              );
              count++;
            }
            state.groups = state.groups.filter((g) => g.id !== group.id);
            for (const context of state.conversations) {
              if (context.groupId === group.id) context.groupId = null;
              delete context.pending;
              delete context.lastQuery;
            }
            replies.push(
              `Grupo ${group.name} excluído. ${count} tarefa(s) ${c.deleteTasks ? 'na lixeira' : 'preservada(s); tarefas ativas na Caixa de entrada'}.`,
            );
          } else if (c.op === 'archive_group' || c.op === 'restore_group') {
            group.archivedAt = c.op === 'archive_group' ? now.toISOString() : null;
            replies.push(`Grupo ${group.name} ${group.archivedAt ? 'arquivado' : 'restaurado'}.`);
          } else {
            if (c.name !== undefined || c.op === 'rename_group') {
              const name = requireValue(c.name, 'o novo nome');
              if (
                state.groups.some((g) => g.id !== group.id && normalize(g.name) === normalize(name))
              )
                throw new DomainError('Já existe um grupo com esse nome.');
              group.name = name;
            }
            for (const key of ['color', 'icon', 'order'] as const)
              if (c[key] !== undefined) Object.assign(group, { [key]: c[key] });
            replies.push(`Grupo ${group.name} atualizado.`);
          }
          break;
        }
        case 'list_groups':
          replies.push(
            state.groups.length
              ? `${state.groups.length} grupo(s):\n${state.groups.map((g) => `• ${g.name}${g.archivedAt ? ' (arquivado)' : ''}`).join('\n')}`
              : 'Você ainda não tem grupos.',
          );
          break;
        case 'create_task': {
          const group = findGroup(state, c.group, ctx);
          const t: Task = {
            id: state.settings.nextTaskId++,
            title: requireValue(c.title, 'o título'),
            description: c.description ?? '',
            groupId: group?.id ?? null,
            status: c.status ?? 'pending',
            priority: c.priority ?? 'normal',
            dueDate: c.dueDate ?? null,
            dueTime: c.dueTime ?? null,
            completedAt: null,
            trashedAt: null,
            purgeAt: null,
            trashReason: null,
            version: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            tags: [...new Set(c.tags ?? [])],
            checklist: c.checklist ?? [],
            recurrence: c.recurrence ?? null,
            reminderMinutes: c.reminderMinutes ?? null,
          };
          if (t.dueTime && !t.dueDate) throw new DomainError('Informe a data junto com o horário.');
          validateSchedule(t);
          state.tasks.push(t);
          touch(t, 'Tarefa criada');
          ctx.taskIds = [t.id];
          replies.push(
            `#${t.id} ${t.title} adicionada em ${group?.name ?? 'Caixa de entrada'} — ${dueLabel(t)}.`,
          );
          break;
        }
        case 'update_task': {
          const t = findTask(state, c, ctx);
          if (t.trashedAt) throw new DomainError('Restaure a tarefa da lixeira antes de editar.');
          if (c.description !== undefined && c.appendDescription !== undefined)
            throw new DomainError('Escolha substituir ou acrescentar a descrição.');
          for (const key of [
            'title',
            'description',
            'status',
            'priority',
            'dueDate',
            'dueTime',
            'tags',
            'checklist',
            'recurrence',
            'reminderMinutes',
          ] as const) {
            if (c[key] !== undefined) Object.assign(t, { [key]: c[key] });
          }
          if (c.appendDescription !== undefined)
            t.description = [t.description, c.appendDescription].filter(Boolean).join('\n');
          if (t.description.length > 5000)
            throw new DomainError('A descrição pode ter até 5.000 caracteres.');
          if (c.dueDate === null) t.dueTime = null;
          if (t.dueTime && !t.dueDate) throw new DomainError('Informe a data junto com o horário.');
          if (c.group !== undefined) t.groupId = findGroup(state, c.group, ctx)?.id ?? null;
          if (c.status) t.completedAt = null;
          validateSchedule(t);
          touch(t, 'Tarefa atualizada');
          replies.push(`#${t.id} ${t.title} atualizada — ${dueLabel(t)}.`);
          break;
        }
        case 'complete_task':
        case 'trash_task':
        case 'restore_task': {
          const t = findTask(state, c, ctx);
          if (c.op === 'restore_task') {
            if (!t.trashedAt && t.status !== 'completed') {
              replies.push(`#${t.id} já está ativa.`);
              break;
            }
            t.status = 'pending';
            t.trashedAt = t.purgeAt = t.completedAt = t.trashReason = null;
            touch(t, 'Tarefa restaurada');
            replies.push(`#${t.id} ${t.title} restaurada como pendente.`);
          } else if (c.op === 'complete_task') {
            if (t.trashedAt) throw new DomainError('Restaure a tarefa antes de concluir.');
            if (t.status === 'completed') {
              replies.push(`#${t.id} já está concluída.`);
              break;
            }
            t.status = 'completed';
            t.completedAt = now.toISOString();
            touch(t, 'Tarefa concluída');
            replies.push(`#${t.id} ${t.title} concluída. Mantida no histórico de concluídas.`);
            const dueDate = nextDue(t);
            if (
              dueDate &&
              !state.tasks.some((next) => next.recurringFrom === t.id && !next.trashedAt)
            ) {
              const next: Task = {
                ...structuredClone(t),
                id: state.settings.nextTaskId++,
                dueDate,
                status: 'pending',
                completedAt: null,
                version: 0,
                recurringFrom: t.id,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
                checklist: t.checklist?.map((item) => ({ ...item, done: false })),
              };
              state.tasks.push(next);
              touch(next, 'Próxima ocorrência criada');
              replies.push(`Próxima ocorrência: #${next.id} — ${dueLabel(next)}.`);
            }
          } else {
            if (t.trashedAt) {
              replies.push(`#${t.id} já está na lixeira.`);
              break;
            }
            trash(t, state, now, false);
            touch(t, 'Tarefa descartada');
            replies.push(
              `#${t.id} ${t.title} enviada à lixeira. Exclusão prevista: ${formatDate(t.purgeAt!)}.`,
            );
          }
          break;
        }
        case 'details': {
          const t = findTask(state, c, ctx);
          replies.push(
            `#${t.id} ${t.title}\n${t.description || 'Sem descrição.'}\nGrupo: ${state.groups.find((g) => g.id === t.groupId)?.name ?? 'Caixa de entrada'}\nPrazo: ${dueLabel(t)}\nSituação: ${{ pending: 'pendente', in_progress: 'em andamento', completed: 'concluída' }[t.status]}${t.purgeAt ? `\nExclusão prevista: ${formatDate(t.purgeAt)}` : ''}`,
          );
          break;
        }
        case 'list_tasks': {
          if (c.fromDate && c.toDate && c.fromDate > c.toDate)
            throw new DomainError('O início do período deve vir antes do fim.');
          const groupId =
            c.group !== undefined ? (findGroup(state, c.group, ctx)?.id ?? null) : undefined;
          const all = selectTasks(state, c, now, groupId);
          const page = c.page ?? 1;
          const items = all.slice((page - 1) * 10, page * 10);
          ctx.taskIds = items.map((t) => t.id);
          ctx.lastQuery = { ...c, page };
          const filterName = {
            active: 'ativas',
            today: 'hoje',
            overdue: 'atrasadas',
            no_date: 'sem prazo',
            trash: 'lixeira',
            completed: 'concluídas',
            all: 'todas, incluindo lixeira',
          }[c.filter ?? 'active'];
          replies.push(
            `${all.length} tarefa(s) — ${c.dueDate ? `para ${c.dueDate.split('-').reverse().join('/')}` : filterName}${c.fromDate || c.toDate ? `; período ${c.fromDate ?? 'início'} a ${c.toDate ?? 'fim'}` : ''}${c.search ? `; busca: ${c.search}` : ''}. Página ${page}/${Math.max(1, Math.ceil(all.length / 10))}.\n${items.map((t) => `#${t.id} ${t.title} — ${dueLabel(t)}${t.purgeAt ? `; exclusão: ${formatDate(t.purgeAt)}` : ''}`).join('\n')}${all.length > page * 10 ? '\nEnvie “mostrar mais” para continuar.' : ''}`,
          );
          break;
        }
        case 'undo': {
          const op = [...state.operations].reverse().find((o) => o.channel === channel);
          if (!op || op.undone || !op.undoable)
            throw new DomainError(
              'A última operação não pode ser desfeita. Configurações e finanças não têm desfazer global. Corrija ou restaure lançamentos pelo Financeiro.',
            );
          if (now.getTime() - new Date(op.at).getTime() > 86400000)
            throw new DomainError(
              'O prazo de 24 horas para desfazer terminou. Tarefas na lixeira ainda podem ser restauradas.',
            );
          for (const change of op.groupChanges ?? []) {
            const current = state.groups.find((g) => g.id === change.id) ?? null;
            if (JSON.stringify(current) !== JSON.stringify(change.after))
              throw new DomainError('O grupo foi alterado depois dessa operação.', 409);
            if (
              !change.before &&
              state.tasks.some(
                (t) => t.groupId === change.id && !op.changes.some((c) => c.taskId === t.id),
              )
            )
              throw new DomainError(
                'O grupo recebeu novas tarefas. Mova-as antes de desfazer.',
                409,
              );
            if (
              change.before &&
              state.groups.some(
                (g) => g.id !== change.id && normalize(g.name) === normalize(change.before!.name),
              )
            )
              throw new DomainError('Outro grupo está usando o nome anterior.', 409);
          }
          for (const change of op.changes) {
            const t = state.tasks.find((t) => t.id === change.taskId);
            if (!t)
              throw new DomainError(
                'Uma tarefa dessa operação foi excluída definitivamente. Não é possível desfazer.',
              );
            if (t.version !== change.afterVersion)
              throw new DomainError(
                'Uma tarefa foi alterada depois dessa operação. Atualize e faça uma correção específica.',
                409,
              );
          }
          for (const change of op.changes) {
            const t = state.tasks.find((t) => t.id === change.taskId)!;
            if (change.before) {
              const version = t.version;
              Object.assign(t, change.before, { version });
            } else trash(t, state, now, false);
            touch(t, 'Alteração desfeita');
          }
          for (const change of op.groupChanges ?? []) {
            touchGroup(change.id);
            state.groups = state.groups.filter((g) => g.id !== change.id);
            if (change.before)
              state.groups.push({
                ...structuredClone(change.before),
                version: (change.after?.version ?? change.before.version ?? 0) + 1,
              });
            else
              for (const t of state.tasks.filter((t) => t.groupId === change.id)) {
                t.groupId = null;
                touch(t, 'Grupo desfeito');
              }
          }
          for (const context of state.conversations)
            if (context.groupId && !state.groups.some((g) => g.id === context.groupId))
              context.groupId = null;
          op.undone = true;
          barrier = true;
          replies.push('Última alteração desfeita.');
          break;
        }
      }
      commandIndex++;
    }
  } catch (error) {
    if (!(error instanceof Ambiguity)) throw error;
    // All-or-nothing: retain only the question, never preceding mutations.
    const clean = structuredClone(original);
    const pendingCtx = contextFor(clean, channel, now);
    pendingCtx.pending = {
      commands,
      index: commandIndex,
      field: error.field,
      options: error.options,
      createGroup: error.createGroup,
      question: error.message,
    };
    pendingCtx.expiresAt = new Date(now.getTime() + 30 * 60000).toISOString();
    return {
      state: clean,
      reply: `${error.message}${error.options.length ? '\n' + error.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') : ''}`,
      clarification: true,
    };
  }
  if (mutation) {
    state.settings.revision++;
    state.operations.push({
      id: randomUUID(),
      sequence: state.settings.revision,
      channel,
      at: now.toISOString(),
      changes: [...touched].map(([taskId, before]) => ({
        taskId,
        before,
        afterVersion: state.tasks.find((t) => t.id === taskId)!.version,
      })),
      groupChanges: [...groupChanges].map(([id, before]) => ({
        id,
        before,
        after: structuredClone(state.groups.find((g) => g.id === id) ?? null),
      })),
      undoable: !barrier && (touched.size > 0 || groupChanges.size > 0),
      undone: false,
    });
  }
  return {
    state,
    reply: replies.join('\n\n'),
    clarification: commands.some((c) => c.op === 'clarify' || c.op === 'unsupported'),
  };
}

function findGroupQuiet(state: State, ref: string | null | undefined, ctx: Conversation) {
  try {
    return ref ? findGroup(state, ref, ctx) : null;
  } catch {
    return null;
  }
}

export function pendingAnswer(
  state: State,
  text: string,
  channel: string,
  now: Date,
): Command[] | null {
  const ctx = contextFor(structuredClone(state), channel, now);
  if (normalize(text) === 'mostrar mais' && ctx.lastQuery)
    return [{ ...ctx.lastQuery, page: (ctx.lastQuery.page ?? 1) + 1 }];
  if (!ctx.pending) return null;
  const p = ctx.pending;
  const commands = structuredClone(p.commands);
  if (p.createGroup && ['criar', 'sim', 'sim criar'].includes(normalize(text))) {
    if (commands.length >= 10)
      return [
        {
          op: 'clarify',
          question: 'Crie o grupo separadamente e reenvie a lista (limite de 10 ações).',
        },
      ];
    return [{ op: 'create_group', name: p.createGroup }, ...commands];
  }
  if (['amount', 'description', 'kind'].includes(p.field) && !p.options.length) {
    // O schema recusa acima de 40 caracteres em amount; sem esta checagem a resposta comprida
    // estourava como erro de validação e chegava como “não foi possível processar o pedido”.
    if (p.field === 'amount' && text.trim().length > 40)
      throw new DomainError('Responda só com o valor, como 42,90.');
    if (p.field === 'description' && text.trim().length > 5000)
      throw new DomainError('A descrição precisa ter até 5.000 caracteres.');
    const value =
      p.field === 'kind'
        ? ({ receita: 'income', despesa: 'expense' } as const)[
            normalize(text) as 'receita' | 'despesa'
          ]
        : text.trim();
    if (!value) return null;
    Object.assign(commands[p.index], { [p.field]: value });
    return commands;
  }
  if (/^\d+$/.test(text.trim())) {
    const choice = p.options[Number(text.trim()) - 1];
    if (!choice)
      return [
        {
          op: 'clarify',
          question: 'Essa opção não existe. Informe o nome ou código em um novo comando.',
        },
      ];
    return applyChoice(commands, p, choice);
  }
  const chosen = matchOption(p.options, text);
  return chosen ? applyChoice(commands, p, chosen) : null;
}

// Quase ninguém responde “2” a uma pergunta de duas opções: responde “excluídas”, “manter”,
// “na lixeira”. Sem isto a resposta saía da pergunta e voltava para a IA como pedido novo, e o
// pedido original — que continua reservado aqui — nunca era retomado.
function matchOption(options: PendingOption[], text: string): PendingOption | null {
  const answer = normalize(text);
  if (!answer || answer.length > 60) return null;
  const word = (term: string) =>
    new RegExp(
      `(^|[^a-z0-9])${normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`,
    ).test(answer);
  const matches = options.filter(
    (option) => normalize(option.label) === answer || (option.keywords ?? []).some(word),
  );
  // Uma resposta que serve às duas opções (“excluir o grupo mas manter as tarefas”) não é
  // escolha: devolver null manda a frase para a IA, com a pergunta pendente no contexto.
  return matches.length === 1 ? matches[0] : null;
}
function applyChoice(
  commands: Command[],
  pending: NonNullable<Conversation['pending']>,
  choice: PendingOption,
): Command[] {
  // A pergunta de exclusão cobre o pedido inteiro, então a resposta também.
  if (pending.field === 'confirmed') {
    if (choice.ref === 'false')
      return [
        { op: 'clarify', question: 'Exclusão cancelada. Envie o próximo pedido ou retome a fila.' },
      ];
    for (const c of commands) if (c.op === 'finance_delete') c.confirmed = true;
  } else if (pending.field === 'deleteTasks') {
    for (const c of commands)
      if (c.op === 'delete_group' && c.deleteTasks === undefined)
        c.deleteTasks = choice.ref === 'true';
  } else Object.assign(commands[pending.index], { [pending.field]: choice.ref });
  return commands;
}
