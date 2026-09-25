import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState,
  execute,
  pendingAnswer,
  purge,
  selectTasks,
  localDate,
  type State,
  type Command,
} from '../src/backend/domain';
import { basicInterpret } from '../src/backend/interpreter';

const start = new Date('2026-09-16T15:00:00Z');
function run(state: State, commands: Command[], channel = 'test', now = start) {
  return execute(state, commands, channel, now).state;
}
function task() {
  return run(emptyState(), [
    {
      op: 'create_task',
      title: 'Ler capítulo',
      description: 'Capítulo 3',
      dueDate: '2026-09-18',
      priority: 'high',
    },
  ]);
}
test('cria grupo e pequenas listas atomicamente, preserva Caixa de entrada', () => {
  let state = run(emptyState(), [
    { op: 'create_group', name: 'Cálculo' },
    { op: 'create_task', title: 'Lista 1', group: 'Cálculo' },
    { op: 'create_task', title: 'Lista 2', group: 'contexto' },
    { op: 'create_task', title: 'Comprar pilhas' },
  ]);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[1].groupId, state.groups[0].id);
  assert.equal(state.tasks[2].groupId, null);
  assert.throws(() => run(state, [{ op: 'create_group', name: 'calculo' }]), /existe/);
  const original = structuredClone(state);
  assert.throws(
    () =>
      run(state, [
        { op: 'create_task', title: 'Não salvar' },
        { op: 'update_task', task: '#999', title: 'Nada' },
      ]),
    /encontrei/,
  );
  assert.deepEqual(state, original);
});
test('finalizar preserva fora da lixeira e repetir não altera versão', () => {
  let state = run(task(), [{ op: 'complete_task', task: '#1' }]);
  const completed = structuredClone(state.tasks[0]);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.purgeAt, null);
  assert.equal(completed.trashedAt, null);
  state = run(
    state,
    [{ op: 'complete_task', task: '#1' }],
    'test',
    new Date('2026-09-20T15:00:00Z'),
  );
  assert.deepEqual(state.tasks[0], completed);
  assert.equal(selectTasks(state, { op: 'list_tasks' }, start).length, 0);
  assert.equal(selectTasks(state, { op: 'list_tasks', filter: 'completed' }, start).length, 1);
});
test('mudança da retenção só afeta entradas futuras; restauração preserva campos', () => {
  let state = run(task(), [
    { op: 'trash_task', task: '#1' },
    { op: 'set_retention', days: 7 },
  ]);
  assert.equal(state.tasks[0].purgeAt, '2026-10-16T15:00:00.000Z');
  state = run(state, [{ op: 'restore_task', task: '#1' }]);
  assert.equal(state.tasks[0].description, 'Capítulo 3');
  assert.equal(state.tasks[0].priority, 'high');
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.tasks[0].purgeAt, null);
  state = run(state, [{ op: 'trash_task', task: '#1' }]);
  assert.equal(state.tasks[0].purgeAt, '2026-09-23T15:00:00.000Z');
});
test('descartar não conclui, restaurar marca pendente', () => {
  let state = run(task(), [
    { op: 'update_task', task: '#1', status: 'in_progress' },
    { op: 'trash_task', task: '#1' },
  ]);
  assert.equal(state.tasks[0].status, 'in_progress');
  assert.equal(state.tasks[0].completedAt, null);
  state = run(state, [{ op: 'restore_task', task: '#1' }]);
  assert.equal(state.tasks[0].status, 'pending');
});
test('acréscimo preserva descrição; substituir e remover prazo são explícitos', () => {
  let state = run(task(), [
    { op: 'update_task', task: '#1', appendDescription: 'Somente pares', dueTime: '19:00' },
  ]);
  assert.equal(state.tasks[0].description, 'Capítulo 3\nSomente pares');
  state = run(state, [
    { op: 'update_task', task: '#1', description: 'Outra descrição', dueDate: null },
  ]);
  assert.equal(state.tasks[0].description, 'Outra descrição');
  assert.equal(state.tasks[0].dueTime, null);
});
test('nomes repetidos pedem esclarecimento e não aplicam ações anteriores', () => {
  let state = run(task(), [{ op: 'create_task', title: 'Ler capítulo' }]);
  const result = execute(
    state,
    [
      { op: 'create_task', title: 'Não criar ainda' },
      { op: 'complete_task', task: 'Ler capítulo' },
    ],
    'test',
    start,
  );
  assert.equal(result.clarification, true);
  assert.equal(result.state.tasks.length, 2);
  assert.equal(result.state.tasks[0].status, 'pending');
  const resolved = pendingAnswer(result.state, '2', 'test', start)!;
  state = run(result.state, resolved);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[1].status, 'completed');
});
test('grupo inexistente pede criação, resposta vinculada continua a operação', () => {
  const result = execute(
    emptyState(),
    [{ op: 'create_task', title: 'Estudar', group: 'Física' }],
    'test',
    start,
  );
  assert.equal(result.clarification, true);
  assert.equal(result.state.tasks.length, 0);
  const commands = pendingAnswer(result.state, 'criar', 'test', start)!;
  const state = run(result.state, commands);
  assert.equal(state.groups[0].name, 'Física');
  assert.equal(state.tasks.length, 1);
  assert.equal(pendingAnswer(result.state, 'Anota: outra coisa', 'test', start), null);
});
test('contexto expira após 30 minutos e não vaza entre canais', () => {
  const state = task();
  assert.equal(
    run(state, [{ op: 'complete_task', task: 'contexto' }]).tasks[0].status,
    'completed',
  );
  assert.throws(
    () => run(state, [{ op: 'complete_task', task: 'contexto' }], 'other'),
    /Qual tarefa/,
  );
  assert.throws(
    () =>
      run(
        state,
        [{ op: 'complete_task', task: 'contexto' }],
        'test',
        new Date(start.getTime() + 31 * 60000),
      ),
    /Qual tarefa/,
  );
});
test('desfazer conclusão recupera estado anterior; conflito posterior é recusado', () => {
  let state = run(task(), [{ op: 'update_task', task: '#1', status: 'in_progress' }]);
  state = run(state, [{ op: 'complete_task', task: '#1' }]);
  state = run(state, [{ op: 'undo' }]);
  assert.equal(state.tasks[0].status, 'in_progress');
  assert.equal(state.tasks[0].purgeAt, null);
  state = run(state, [{ op: 'update_task', task: '#1', title: 'Mudança na conversa' }]);
  state = run(state, [{ op: 'update_task', task: '#1', title: 'Mudança no painel' }], 'panel');
  assert.throws(() => run(state, [{ op: 'undo' }]), /alterada depois/);
});
test('desfazer lista inteira move criações para lixeira sem perder histórico', () => {
  let state = run(emptyState(), [
    { op: 'create_task', title: 'A' },
    { op: 'create_task', title: 'B' },
  ]);
  state = run(state, [{ op: 'undo' }]);
  assert.ok(state.tasks.every((t) => t.trashedAt));
  assert.equal(state.history.length, 4);
  assert.throws(() => run(state, [{ op: 'undo' }]), /não pode/);
});
test('desfazer não pula configuração e expira em 24h', () => {
  const state = run(task(), [{ op: 'set_retention', days: 15 }]);
  assert.throws(() => run(state, [{ op: 'undo' }]), /não pode/);
  assert.throws(
    () => run(task(), [{ op: 'undo' }], 'test', new Date(start.getTime() + 86400001)),
    /24 horas/,
  );
});
test('limpeza preserva restauradas e remove conteúdo do histórico e da reversão', () => {
  let state = run(task(), [
    { op: 'create_task', title: 'Restaurada' },
    { op: 'trash_task', task: '#1' },
    { op: 'trash_task', task: '#2' },
  ]);
  const early = purge(state, new Date('2026-10-16T14:59:59Z'));
  assert.equal(early.removed.length, 0);
  state = run(state, [{ op: 'restore_task', task: '#2' }]);
  const cleaned = purge(state, new Date('2026-10-16T15:00:00Z'));
  assert.deepEqual(cleaned.removed, [1]);
  assert.equal(cleaned.state.tasks[0].id, 2);
  assert.equal(JSON.stringify(cleaned.state).includes('Capítulo 3'), false);
  assert.equal(
    cleaned.state.history.some((h) => h.taskId === 1),
    false,
  );
  assert.throws(() => run(cleaned.state, [{ op: 'restore_task', task: '#1' }]), /excluída/);
});
test('dia local usa Bahia; data sem horário só atrasa no dia seguinte', () => {
  const time = new Date('2026-09-17T01:00:00Z');
  assert.equal(localDate(time), '2026-09-16');
  const state = run(emptyState(), [{ op: 'create_task', title: 'Hoje', dueDate: '2026-09-16' }]);
  assert.equal(selectTasks(state, { op: 'list_tasks', filter: 'overdue' }, time).length, 0);
  assert.equal(
    selectTasks(state, { op: 'list_tasks', filter: 'overdue' }, new Date('2026-09-17T03:00:01Z'))
      .length,
    1,
  );
});
test('paginação informa total e continuação; referências usam última lista', () => {
  let state = emptyState();
  for (let i = 0; i < 12; i++) state = run(state, [{ op: 'create_task', title: `Item ${i}` }]);
  const first = execute(state, [{ op: 'list_tasks' }], 'test', start);
  assert.match(first.reply, /12 tarefa/);
  assert.match(first.reply, /mostrar mais/);
  const second = execute(
    first.state,
    pendingAnswer(first.state, 'mostrar mais', 'test', start),
    'test',
    start,
  );
  assert.match(second.reply, /Página 2\/2/);
  assert.equal(second.state.conversations[0].taskIds.length, 2);
});
test('validação rejeita datas inexistentes, retenção inválida e mais de 100 ações no painel', () => {
  assert.throws(() =>
    run(emptyState(), [{ op: 'create_task', title: 'Inválida', dueDate: '2026-02-30' }]),
  );
  assert.throws(() => run(emptyState(), [{ op: 'set_retention', days: 0 }]));
  assert.throws(() =>
    run(
      emptyState(),
      Array.from({ length: 101 }, () => ({ op: 'create_task', title: 'A' })),
    ),
  );
  assert.throws(
    () =>
      run(task(), [{ op: 'update_task', task: '#1', expectedVersion: 99, title: 'Não alterar' }]),
    /outra tela/,
  );
});
test('comandos básicos interpretam português e datas relativas sem LLM', () => {
  for (const text of ['Finalizei #1', 'Terminei a tarefa #1', 'Concluí #1'])
    assert.equal(basicInterpret(text)?.[0].op, 'complete_task');
  assert.deepEqual(basicInterpret('Ler capítulo é para amanhã', start), [
    { op: 'update_task', task: 'Ler capítulo', dueDate: '2026-09-17' },
  ]);
  assert.equal(
    basicInterpret('Em Cálculo, adicione ler capítulo 3, fazer lista 1 e revisar limites')?.length,
    3,
  );
  assert.equal(basicInterpret('Me lembre amanhã de fazer isso'), null);
});
test('pedido com dois comandos encadeados por "e" não é resolvido por um padrão básico só', () => {
  assert.equal(
    basicInterpret('crie um grupo chamado infojr e adicione a tarefa chamada proposta'),
    null,
  );
  assert.equal(basicInterpret('exclua #1 e restaure #2'), null);
});
test('na lixeira só valem tirar e colocar: excluir o grupo não altera a tarefa descartada', () => {
  let state = run(emptyState(), [
    { op: 'create_group', name: 'Cálculo' },
    { op: 'create_task', title: 'Lista 1', group: 'Cálculo' },
    { op: 'create_task', title: 'Lista 2', group: 'Cálculo' },
  ]);
  state = run(state, [{ op: 'trash_task', task: '#1' }]);
  const group = state.groups[0].id;
  const discarded = structuredClone(state.tasks.find((t) => t.id === 1)!);
  const before = state.history.filter((h) => h.taskId === 1).length;
  const after = run(state, [{ op: 'delete_group', group: 'Cálculo', deleteTasks: true }]);
  // Nem versão, nem grupo, nem linha de histórico: a tarefa na lixeira sai igual como entrou.
  assert.deepEqual(
    after.tasks.find((t) => t.id === 1),
    discarded,
  );
  assert.equal(after.tasks.find((t) => t.id === 1)!.groupId, group);
  assert.equal(after.history.filter((h) => h.taskId === 1).length, before);
  // A ativa segue o pedido normalmente.
  assert.ok(after.tasks.find((t) => t.id === 2)!.trashedAt);
  assert.equal(after.tasks.find((t) => t.id === 2)!.groupId, null);
});
test('a pergunta da exclusão de grupo conta só as tarefas que ela vai afetar', () => {
  let state = run(emptyState(), [
    { op: 'create_group', name: 'Cálculo' },
    { op: 'create_task', title: 'Lista 1', group: 'Cálculo' },
    { op: 'create_task', title: 'Lista 2', group: 'Cálculo' },
  ]);
  state = run(state, [{ op: 'trash_task', task: '#1' }]);
  const asked = execute(state, [{ op: 'delete_group', group: 'Cálculo' }], 'test', start);
  assert.ok(asked.clarification);
  assert.match(asked.reply, /1 tarefa\(s\)/);
  const done = execute(
    state,
    [{ op: 'delete_group', group: 'Cálculo', deleteTasks: false }],
    'test',
    start,
  );
  assert.match(done.reply, /1 já na lixeira, mantida\(s\) como estava\(m\)/);
});
test('desfazer a exclusão do grupo devolve a tarefa que estava na lixeira para ele', () => {
  let state = run(emptyState(), [
    { op: 'create_group', name: 'Cálculo' },
    { op: 'create_task', title: 'Lista 1', group: 'Cálculo' },
  ]);
  const group = state.groups[0].id;
  state = run(state, [{ op: 'trash_task', task: '#1' }]);
  state = run(state, [{ op: 'delete_group', group: 'Cálculo', deleteTasks: true }]);
  assert.equal(state.groups.length, 0);
  state = run(state, [{ op: 'undo' }]);
  assert.equal(state.groups[0].id, group);
  assert.equal(state.tasks.find((t) => t.id === 1)!.groupId, group);
});
test('editar e concluir continuam recusados enquanto a tarefa está na lixeira', () => {
  const state = run(task(), [{ op: 'trash_task', task: '#1' }]);
  assert.throws(() => run(state, [{ op: 'update_task', task: '#1', title: 'Outro' }]), /Restaure/);
  assert.throws(() => run(state, [{ op: 'complete_task', task: '#1' }]), /Restaure/);
  assert.match(execute(state, [{ op: 'trash_task', task: '#1' }], 'test', start).reply, /já está/);
  const back = run(state, [{ op: 'restore_task', task: '#1' }]);
  assert.equal(back.tasks[0].trashedAt, null);
  assert.equal(back.tasks[0].status, 'pending');
});
