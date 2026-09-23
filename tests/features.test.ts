import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  emptyState,
  execute,
  pendingAnswer,
  purge,
  selectTasks,
  type State,
  type Command,
} from '../src/backend/domain';
import { commandsSchema } from '../src/backend/domain/types';
import { queryDate, basicInterpret, stripFiller, capitalize } from '../src/backend/interpreter';
import { checkReply } from '../src/backend/llm';
import { nextDue } from '../src/backend/domain/recurrence';
import { createDatabase, loadState } from '../src/backend/db';
import { exportBackup, importBackup } from '../src/backend/backup';
import { panelAction } from '../src/backend/service';
import { migrationTarget } from '../scripts/migrate';
const now = new Date('2026-09-22T15:00:00Z');
const run = (s: State, commands: Command[], channel = 'panel') =>
  execute(s, commands, channel, now).state;
function grouped() {
  return run(emptyState(), [
    { op: 'create_group', name: 'Estudos' },
    { op: 'create_task', title: 'Revisão', group: 'Estudos', dueDate: '2026-09-24' },
    { op: 'create_task', title: 'Outra', group: 'Estudos' },
  ]);
}
test('excluir grupo preserva tarefas, lixeira existente e permite desfazer', () => {
  let state = run(grouped(), [{ op: 'trash_task', task: '#2' }]);
  const original = structuredClone(state);
  state = run(state, [{ op: 'delete_group', group: 'Estudos', deleteTasks: false }]);
  assert.equal(state.groups.length, 0);
  assert.equal(state.tasks[0].groupId, null);
  assert.equal(state.tasks[0].trashedAt, null);
  assert.equal(state.tasks[1].purgeAt, original.tasks[1].purgeAt);
  state = run(state, [{ op: 'undo' }]);
  assert.equal(state.groups[0].name, 'Estudos');
  assert.ok(state.tasks.every((t) => t.groupId === state.groups[0].id));
});
test('excluir grupo com tarefas usa lixeira e é atômico, inclusive em conflitos', () => {
  const original = grouped();
  let state = run(original, [{ op: 'delete_group', group: 'Estudos', deleteTasks: true }]);
  assert.ok(state.tasks.every((t) => t.trashedAt && t.groupId === null));
  state = run(state, [{ op: 'restore_task', task: '#1' }], 'web');
  assert.throws(() => run(state, [{ op: 'undo' }]), /alterada depois/);
  assert.equal(state.groups.length, 0);
});
test('arquivar oculta das consultas gerais; edição e renomeação têm desfazer', () => {
  let state = run(grouped(), [
    {
      op: 'update_group',
      group: 'Estudos',
      name: 'Faculdade',
      color: 'rose',
      icon: 'book',
      order: 3,
    },
  ]);
  state = run(state, [{ op: 'undo' }]);
  assert.equal(state.groups[0].name, 'Estudos');
  state = run(state, [{ op: 'archive_group', group: 'Estudos' }]);
  assert.equal(selectTasks(state, { op: 'list_tasks' }, now).length, 0);
  assert.equal(selectTasks(state, { op: 'list_tasks' }, now, state.groups[0].id).length, 2);
  state = run(state, [{ op: 'restore_group', group: 'Estudos' }]);
  assert.equal(selectTasks(state, { op: 'list_tasks' }, now).length, 2);
});
test('desfazer criação de grupo recusa novas tarefas de outro canal', () => {
  let state = run(emptyState(), [{ op: 'create_group', name: 'Trabalho' }]);
  state = run(state, [{ op: 'create_task', title: 'Nova', group: 'Trabalho' }], 'web');
  assert.throws(() => run(state, [{ op: 'undo' }]), /novas tarefas/);
});
test('data exata do dia 24 não inclui outras datas nem tarefas sem prazo', () => {
  const state = run(grouped(), [{ op: 'create_task', title: 'Outro dia', dueDate: '2026-09-28' }]);
  const commands = basicInterpret('quais tarefas eu tenho pro dia 24', now)!;
  assert.equal(commands[0].dueDate, '2026-09-24');
  const reply = execute(state, commands, 'web', now).reply;
  assert.match(reply, /1 tarefa\(s\)/);
  assert.match(reply, /para 24\/09\/2026/);
  assert.match(reply, /Revisão/);
  assert.doesNotMatch(reply, /Outro dia|Outra —/);
  assert.equal(queryDate('tarefas para 24/10/2027', now), '2027-10-24');
  assert.throws(() => queryDate('tarefas dia 31/02', now), /não existe/);
  assert.equal(
    selectTasks(state, { op: 'list_tasks', fromDate: '2026-09-24', toDate: '2026-09-28' }, now)
      .length,
    2,
  );
});
test('concluídas sobrevivem à limpeza e recorrência cria somente uma próxima ocorrência', () => {
  let state = run(emptyState(), [
    {
      op: 'create_task',
      title: 'Mensal',
      dueDate: '2027-01-31',
      recurrence: { frequency: 'monthly', interval: 1 },
      tags: ['estudo'],
      checklist: [{ id: randomUUID(), title: 'Ler', done: true }],
      reminderMinutes: 15,
    },
  ]);
  state = run(state, [{ op: 'complete_task', task: '#1' }]);
  assert.equal(state.tasks[1].dueDate, '2027-02-28');
  assert.equal(state.tasks[1].checklist![0].done, false);
  assert.equal(nextDue(state.tasks[1]), '2027-03-31');
  state = run(state, [{ op: 'complete_task', task: '#1' }]);
  assert.equal(state.tasks.length, 2);
  assert.equal(purge(state, new Date('2030-01-01')).state.tasks.length, 2);
  assert.equal(selectTasks(state, { op: 'list_tasks', filter: 'completed' }, now).length, 1);
  assert.equal(selectTasks(state, { op: 'list_tasks', tag: 'estudo' }, now).length, 1);
  assert.throws(
    () =>
      run(emptyState(), [
        { op: 'create_task', title: 'Sem data', recurrence: { frequency: 'daily', interval: 1 } },
      ]),
    /Defina uma data/,
  );
});
test('recorrência semanal respeita os dias escolhidos', () => {
  const state = run(emptyState(), [
    {
      op: 'create_task',
      title: 'Treino',
      dueDate: '2026-09-22',
      recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 3, 5] },
    },
  ]);
  assert.equal(nextDue(state.tasks[0]), '2026-09-23');
});
test('lote do painel aceita 100 tarefas, mantendo o limite de 10 comandos de IA', () => {
  const commands = Array.from({ length: 100 }, (_, i) => ({
    op: 'create_task' as const,
    title: `Tarefa ${i}`,
  }));
  assert.equal(run(emptyState(), commands).tasks.length, 100);
  assert.throws(() => commandsSchema.parse(commands));
  assert.throws(() =>
    run(grouped(), [
      { op: 'complete_task', task: '#1' },
      { op: 'update_task', task: '#2', expectedVersion: 99 },
    ]),
  );
});
test('backup valida referências, não exporta credenciais e restaura nomes com IDs diferentes', async () => {
  const database = await createDatabase();
  try {
    await panelAction(
      [
        { op: 'create_group', name: 'Estudos' },
        { op: 'create_task', title: "Robert'); DROP TABLE agenda_tasks;--", group: 'Estudos' },
      ],
      randomUUID(),
      database,
    );
    const backup = await exportBackup(database);
    assert.equal('security' in backup, false);
    assert.equal('providers' in backup, false);
    const changed = structuredClone(backup);
    const id = randomUUID();
    changed.groups[0].id = id;
    changed.tasks[0].groupId = id;
    await importBackup(changed, (await loadState(database)).settings.revision, database);
    assert.equal((await loadState(database)).groups[0].id, id);
    await assert.rejects(importBackup(backup, 0, database), /agenda mudou/);
    const invalid = structuredClone(changed);
    invalid.tasks[0].groupId = randomUUID();
    await assert.rejects(importBackup(invalid, 2, database), /inexistente/);
    assert.equal((await loadState(database)).tasks.length, 1);
  } finally {
    await database.close();
  }
});

test('migração preserva concluídas legadas e não ressuscita tarefas descartadas', async () => {
  const { featureMigration } = await import('../src/backend/schema');
  const database = await createDatabase();
  try {
    await panelAction(
      [
        { op: 'create_task', title: 'Concluída antiga' },
        { op: 'complete_task', task: '#1' },
        { op: 'create_task', title: 'Descartada' },
        { op: 'trash_task', task: '#2' },
      ],
      randomUUID(),
      database,
    );
    await database.query(
      `UPDATE agenda_tasks SET data=data || '{"trashedAt":"2020-01-01T00:00:00.000Z","purgeAt":"2020-02-01T00:00:00.000Z","trashReason":"completed"}'::jsonb WHERE id='1'`,
    );
    for (const statement of featureMigration.split(';').filter((s) => s.trim()))
      await database.query(statement);
    const state = await loadState(database);
    assert.equal(state.tasks[0].trashedAt, null);
    assert.equal(state.tasks[0].status, 'completed');
    assert.ok(state.tasks[1].trashedAt);
    assert.ok(purge(state, new Date('2030-01-01')).state.tasks.some((t) => t.id === 1));
  } finally {
    await database.close();
  }
});
test('desfazer conclusão recorrente permite concluir de novo sem perder próxima ocorrência', () => {
  let state = run(emptyState(), [
    {
      op: 'create_task',
      title: 'Diária',
      dueDate: '2026-09-22',
      recurrence: { frequency: 'daily', interval: 1 },
    },
  ]);
  state = run(state, [{ op: 'complete_task', task: '#1' }]);
  state = run(state, [{ op: 'undo' }]);
  assert.equal(state.tasks[0].status, 'pending');
  state = run(state, [{ op: 'complete_task', task: '#1' }]);
  assert.equal(state.tasks.filter((t) => !t.trashedAt && t.status === 'pending').length, 1);
  assert.equal(
    state.tasks.find((t) => !t.trashedAt && t.status === 'pending')!.dueDate,
    '2026-09-23',
  );
});

test('pedido fora do catálogo responde “não consigo fazer ainda” e não altera nada', () => {
  const base = grouped();
  const result = execute(
    base,
    [{ op: 'unsupported', question: 'Ainda não envio e-mail; posso criar a tarefa de enviar.' }],
    'web',
    now,
  );
  assert.match(result.reply, /^Não consigo fazer isso ainda\./);
  assert.match(result.reply, /Ainda não envio e-mail/);
  assert.equal(result.clarification, true);
  assert.deepEqual(result.state.tasks, base.tasks);
  assert.equal(result.state.settings.revision, base.settings.revision);
  // Sem detalhe, a frase sozinha já é a resposta inteira.
  assert.equal(
    execute(base, [{ op: 'unsupported' }], 'web', now).reply,
    'Não consigo fazer isso ainda.',
  );
  // Nunca em lote: metade de um pedido não suportado não pode ser executada.
  assert.throws(
    () => execute(base, [{ op: 'create_task', title: 'X' }, { op: 'unsupported' }], 'web', now),
    /separadamente/,
  );
});
test('consulta de dia deixa outro mês para o modelo e mantém o atalho do mês atual', () => {
  // "pro dia 24" sem mais nada é o dia 24 deste mês, e o atalho corrige um modelo que
  // responderia com a lista inteira.
  assert.equal(queryDate('quais tarefas eu tenho pro dia 24', now), '2026-09-24');
  assert.equal(queryDate('e pro dia 24/10?', now), '2026-10-24');
  // Já estas nomeiam outro mês: o atalho sai de cena para não sobrescrever a data do modelo.
  for (const text of [
    'e pro dia 24 do mes que vem?',
    'e pro dia 24 do mês passado?',
    'tarefas pro dia 24 do próximo mês',
    'quais tarefas eu tenho pro dia 24 de outubro',
  ])
    assert.equal(queryDate(text, now), null, text);
});
test('palavras de conversa não entram no título da tarefa', () => {
  assert.equal(stripFiller('acido tbm'), 'acido');
  assert.equal(stripFiller('comprar pilhas, por favor'), 'comprar pilhas');
  assert.equal(stripFiller('ler capítulo 3 tbm valeu'), 'ler capítulo 3');
  // O que parece marcador mas é a tarefa inteira continua de pé.
  assert.equal(stripFiller('tbm'), 'tbm');
  assert.equal(stripFiller('revisar o ok do cliente'), 'revisar o ok do cliente');
});
test('títulos e descrições começam com letra maiúscula', () => {
  assert.equal(capitalize('comprar pão'), 'Comprar pão');
  assert.equal(capitalize('ávila'), 'Ávila');
  assert.equal(capitalize('“ler” isso'), '“Ler” isso');
  // Marca com a segunda letra maiúscula não vira "IPhone".
  assert.equal(capitalize('iPhone novo'), 'iPhone novo');
  assert.equal(basicInterpret('Anota: comprar pilhas')?.[0]?.op, 'create_task');
});
test('reescrita da resposta só é aceita se preservar as linhas de tarefas', () => {
  const original =
    '2 tarefa(s) — para 24/09/2026. Página 1/1.\n#7 revisão sistemática — 24/09/2026\n#4 proposta — 24/09/2026';
  const faithful = checkReply(
    original,
    JSON.stringify({
      reply:
        'Você tem 2 tarefas para 24/09/2026:\n#7 revisão sistemática — 24/09/2026\n#4 proposta — 24/09/2026',
    }),
  );
  assert.equal(faithful.ok, true);
  assert.match(faithful.ok ? faithful.value : '', /#7 revisão sistemática — 24\/09\/2026/);
  const cases: Record<string, string> = {
    // Data trocada dentro da linha da tarefa.
    alterada: '#7 revisão sistemática — 23/09/2026\n#4 proposta — 24/09/2026',
    // Tarefa que não existe.
    inventada:
      '#7 revisão sistemática — 24/09/2026\n#4 proposta — 24/09/2026\n#9 ligar para o banco — 25/09/2026',
    // Tarefa omitida.
    omitida: '#7 revisão sistemática — 24/09/2026',
    // Ordem trocada.
    reordenada: '#4 proposta — 24/09/2026\n#7 revisão sistemática — 24/09/2026',
  };
  for (const [name, reply] of Object.entries(cases))
    assert.equal(checkReply(original, JSON.stringify({ reply })).ok, false, name);
  assert.equal(checkReply(original, 'não é json').ok, false);
  assert.equal(checkReply(original, JSON.stringify({ reply: '  ' })).ok, false);
  assert.equal(checkReply(original, JSON.stringify({ reply: 'a'.repeat(5000) })).ok, false);
});

test('excluir grupo sem dizer o destino das tarefas pergunta e retoma com a resposta', () => {
  const original = grouped();
  const pergunta = execute(original, [{ op: 'delete_group', group: 'Estudos' }], 'web', now);
  // Pergunta, não erro: o pedido fica reservado à espera da escolha.
  assert.equal(pergunta.clarification, true);
  assert.match(pergunta.reply, /O grupo Estudos tem 2 tarefa\(s\)/);
  assert.match(pergunta.reply, /1\. Manter as tarefas/);
  assert.match(pergunta.reply, /2\. Enviar as tarefas para a lixeira/);
  assert.deepEqual(pergunta.state.groups, original.groups);
  assert.deepEqual(pergunta.state.tasks, original.tasks);

  // A resposta em palavras vale tanto quanto o número — foi assim que o pedido se perdia.
  for (const resposta of ['excluidas', 'excluídas', 'na lixeira', 'apagar', '2']) {
    const commands = pendingAnswer(pergunta.state, resposta, 'web', now);
    assert.deepEqual(
      commands,
      [{ op: 'delete_group', group: 'Estudos', deleteTasks: true }],
      resposta,
    );
  }
  for (const resposta of ['manter', 'preservar', 'caixa de entrada', '1']) {
    const commands = pendingAnswer(pergunta.state, resposta, 'web', now);
    assert.deepEqual(
      commands,
      [{ op: 'delete_group', group: 'Estudos', deleteTasks: false }],
      resposta,
    );
  }
  // Resposta que serve às duas opções, ou que é outro pedido, sai da pergunta e vai para a IA.
  for (const resposta of ['excluir o grupo mas manter as tarefas', 'quais tarefas existem?'])
    assert.equal(pendingAnswer(pergunta.state, resposta, 'web', now), null, resposta);

  // E o pedido retomado faz o que foi pedido no começo.
  const feito = execute(
    pergunta.state,
    pendingAnswer(pergunta.state, 'excluidas', 'web', now)!,
    'web',
    now,
  );
  assert.equal(feito.state.groups.length, 0);
  assert.ok(feito.state.tasks.every((t) => t.trashedAt && t.groupId === null));
  assert.match(feito.reply, /Grupo Estudos excluído\. 2 tarefa\(s\) na lixeira\./);
});

test('migração escolhe o banco pela intenção declarada, não pelo modo do .env', () => {
  const admin =
    'postgresql://admin:segredo@ep-exemplo.sa-east-1.aws.neon.tech/neondb?sslmode=require';
  // O caso que motivou a precedência: .env de desenvolvimento com a URL de migração informada.
  // Antes, isto preparava o banco embutido e anunciava sucesso, sem tocar no banco publicado.
  const publicado = migrationTarget({
    DATABASE_MODE: 'local',
    DATABASE_MIGRATION_URL: admin,
    LOCAL_DATABASE_PATH: '.data/agenda',
  });
  assert.equal(publicado.url, admin);
  // O rótulo confirma onde foi aplicada, sem expor usuário nem senha.
  assert.equal(publicado.label, 'ep-exemplo.sa-east-1.aws.neon.tech/neondb');
  assert.ok(!publicado.label.includes('segredo'));
  assert.ok(!publicado.label.includes('admin'));

  // Sem a URL de migração, o modo manda: local prepara o banco embutido.
  const local = migrationTarget({ DATABASE_MODE: 'local', DATABASE_URL: admin });
  assert.equal(local.url, undefined);
  assert.match(local.label, /banco local em \.data\/agenda/);

  // Em postgres, a conexão do app serve se nenhuma administrativa for informada.
  assert.equal(migrationTarget({ DATABASE_MODE: 'postgres', DATABASE_URL: admin }).url, admin);
  // E sem nenhuma conexão, a falta é dita antes de qualquer tentativa.
  assert.throws(
    () => migrationTarget({ DATABASE_MODE: 'postgres' }),
    /Falta a conexão de migração/,
  );
});

test('excluir vários grupos faz uma pergunta só e a resposta vale para todos', () => {
  const original = run(grouped(), [
    { op: 'create_group', name: 'Casa' },
    { op: 'create_task', title: 'Lavar louça', group: 'Casa' },
  ]);
  const pergunta = execute(
    original,
    [
      { op: 'delete_group', group: 'Estudos' },
      { op: 'delete_group', group: 'Casa' },
    ],
    'web',
    now,
  );
  assert.equal(pergunta.clarification, true);
  assert.match(pergunta.reply, /Os grupos Estudos \(2 tarefa\(s\)\), Casa \(1 tarefa\(s\)\)/);
  const commands = pendingAnswer(pergunta.state, 'excluidas', 'web', now)!;
  assert.ok(commands.every((c) => c.deleteTasks === true));
  const feito = execute(pergunta.state, commands, 'web', now);
  assert.equal(feito.clarification, false);
  assert.equal(feito.state.groups.length, 0);
});
