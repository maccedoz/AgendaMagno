import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/backend/db';
import {
  emptyState,
  execute,
  pendingAnswer,
  type Command,
  type State,
} from '../src/backend/domain';
import { evaluate, perfectDays } from '../src/backend/goals/streak';
import { formatAmount, parseGoalAmount } from '../src/backend/goals/rules';
import { goalsSnapshot, loadGoals } from '../src/backend/goals/store';
import type { Goal, GoalLog } from '../src/backend/goals/types';
import { panelAction, snapshot } from '../src/backend/service';
import { summarySnapshot } from '../src/backend/summary-store';
import { exportBackup, importBackup } from '../src/backend/backup';

// 15h em Salvador (18h UTC): depois das 12h, ontem já está fechado.
const at = (date: string, hour = 15) =>
  new Date(`${date}T${String(hour + 3).padStart(2, '0')}:00:00Z`);
function goal(extra: Partial<Goal> = {}): Goal {
  return {
    id: randomUUID(),
    title: 'Água',
    icon: 'water',
    kind: 'amount',
    unit: 'ml',
    period: 'daily',
    weekdays: null,
    countDays: false,
    schedules: [],
    targets: [{ from: '2026-09-01', amount: 2500 }],
    quickAdds: [250, 500],
    pauses: [],
    reminderTime: null,
    startDate: '2026-09-01',
    archivedAt: null,
    version: 1,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    ...extra,
  };
}
const log = (g: Goal, date: string, amount: number): GoalLog => ({
  id: randomUUID(),
  goalId: g.id,
  date,
  amount,
  source: 'panel',
  createdAt: `${date}T12:00:00.000Z`,
});
const days = (from: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${from}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
  );

test('dias seguidos cumpridos somam; hoje sem registro fica em aberto, sem zerar', () => {
  const g = goal();
  const logs = days('2026-09-01', 5).map((d) => log(g, d, 2500));
  const p = evaluate(g, logs, at('2026-09-06'));
  assert.equal(p.streak, 5);
  assert.equal(p.current.status, 'open');
  assert.equal(p.remaining, 2500);
  const done = evaluate(
    g,
    [...logs, log(g, '2026-09-06', 2000), log(g, '2026-09-06', 500)],
    at('2026-09-06'),
  );
  assert.equal(done.streak, 6);
  assert.equal(done.current.status, 'met');
});
test('dia perdido sem congelamento zera e informa a ofensiva perdida', () => {
  const g = goal();
  const logs = days('2026-09-01', 4).map((d) => log(g, d, 3000));
  const p = evaluate(g, logs, at('2026-09-06'));
  assert.equal(p.streak, 0);
  assert.equal(p.lost, 4);
  assert.equal(p.best, 4);
  assert.equal(p.recent.find((r) => r.start === '2026-09-05')!.status, 'missed');
});
test('7 cumpridos dão um congelamento que salva o dia perdido; dois perdidos seguidos zeram', () => {
  const g = goal();
  const seven = days('2026-09-01', 7).map((d) => log(g, d, 2500));
  const saved = evaluate(g, [...seven, log(g, '2026-09-09', 2500)], at('2026-09-09'));
  assert.equal(saved.streak, 8);
  assert.equal(saved.freezes, 0);
  assert.equal(saved.recent.find((r) => r.start === '2026-09-08')!.status, 'frozen');
  const broken = evaluate(g, [...seven, log(g, '2026-09-10', 2500)], at('2026-09-10'));
  assert.equal(broken.streak, 1);
  // No máximo dois guardados, mesmo com 21 dias seguidos.
  const long = days('2026-09-01', 21).map((d) => log(g, d, 2500));
  assert.equal(evaluate(g, long, at('2026-09-21')).freezes, 2);
});
test('ontem sem registro continua em aberto até as 12h', () => {
  const g = goal();
  const logs = days('2026-09-01', 3).map((d) => log(g, d, 2500));
  const morning = evaluate(g, logs, at('2026-09-05', 9));
  assert.equal(morning.streak, 3);
  assert.equal(morning.grace?.start, '2026-09-04');
  const afternoon = evaluate(g, logs, at('2026-09-05', 13));
  assert.equal(afternoon.streak, 0);
  assert.equal(afternoon.grace, null);
});
test('registro às 23h30 em Salvador cai no dia local, mesmo às 02h30 UTC', () => {
  const state = withGoal(
    goal({ startDate: '2026-09-10', targets: [{ from: '2026-09-10', amount: 2500 }] }),
  );
  const late = new Date('2026-09-11T02:30:00Z');
  const result = execute(
    state,
    [{ op: 'goal_log', goal: 'Água', amount: '500 ml' }],
    'panel',
    late,
  );
  assert.equal(result.state.goals!.logs[0].date, '2026-09-10');
});
test('semanal 6x conta dias distintos; contando registros, dois treinos no mesmo dia valem 2', () => {
  const g = goal({
    title: 'Treino',
    kind: 'count',
    unit: 'vezes',
    period: 'weekly',
    countDays: true,
    targets: [{ from: '2026-08-31', amount: 6 }],
    startDate: '2026-08-31',
  });
  const six = days('2026-08-31', 6).map((d) => log(g, d, 1));
  assert.equal(evaluate(g, six, at('2026-09-08')).streak, 1);
  const crowded = [...days('2026-08-31', 5), '2026-08-31', '2026-09-01'].map((d) => log(g, d, 1));
  const p = evaluate(g, crowded, at('2026-09-08'));
  assert.equal(p.recent[0].amount, 5);
  assert.equal(p.streak, 0);
  const each = evaluate({ ...g, countDays: false }, crowded, at('2026-09-08'));
  assert.equal(each.recent[0].amount, 7);
  assert.equal(each.streak, 1);
});
test('semana impossível é avisada antes de acabar', () => {
  const g = goal({
    kind: 'count',
    unit: 'vezes',
    period: 'weekly',
    countDays: true,
    targets: [{ from: '2026-09-07', amount: 6 }],
    startDate: '2026-09-07',
  });
  // Sábado sem nenhum treino: faltam 6, restam 2 dias.
  assert.equal(evaluate(g, [], at('2026-09-12')).impossible, true);
  assert.equal(evaluate(g, [], at('2026-09-08')).impossible, false);
});
test('mensal, pausa, dias da semana e mudança de alvo', () => {
  const monthly = goal({
    title: 'Livros',
    unit: 'páginas',
    period: 'monthly',
    targets: [{ from: '2026-08-01', amount: 300 }],
    startDate: '2026-08-01',
  });
  const p = evaluate(monthly, [log(monthly, '2026-08-20', 310)], at('2026-09-10'));
  assert.equal(p.streak, 1);
  assert.equal(p.current.start, '2026-09-01');
  assert.equal(p.current.end, '2026-09-30');

  const paused = goal({ pauses: [{ from: '2026-09-03', to: '2026-09-04' }] });
  const logs = ['2026-09-01', '2026-09-02', '2026-09-05'].map((d) => log(paused, d, 2500));
  assert.equal(evaluate(paused, logs, at('2026-09-05')).streak, 3);

  // Só de segunda a sexta: o fim de semana sem registro não quebra.
  const weekdays = goal({ weekdays: [1, 2, 3, 4, 5], startDate: '2026-09-04' });
  const w = ['2026-09-04', '2026-09-07'].map((d) => log(weekdays, d, 2500));
  assert.equal(evaluate(weekdays, w, at('2026-09-07')).streak, 2);

  // Alvo subiu hoje: ontem continua julgado pelo alvo antigo.
  const changed = goal({
    targets: [
      { from: '2026-09-01', amount: 2000 },
      { from: '2026-09-03', amount: 3000 },
    ],
  });
  const c = evaluate(
    changed,
    ['2026-09-01', '2026-09-02'].map((d) => log(changed, d, 2000)),
    at('2026-09-03'),
  );
  assert.equal(c.streak, 2);
  assert.equal(c.current.target, 3000);
});
test('dias perfeitos exigem todas as metas diárias do dia', () => {
  const water = goal();
  const read = goal({
    title: 'Ler',
    unit: 'páginas',
    targets: [{ from: '2026-09-01', amount: 10 }],
  });
  const weekly = goal({ period: 'weekly', kind: 'count', unit: 'vezes', countDays: true });
  const logs = [
    ...days('2026-09-01', 3).map((d) => log(water, d, 2500)),
    ...['2026-09-01', '2026-09-03'].map((d) => log(read, d, 10)),
  ];
  const p = perfectDays([water, read, weekly], logs, at('2026-09-03'));
  assert.equal(p.streak, 1);
  assert.equal(p.best, 1);
  assert.equal(p.today, 'met');
  assert.equal(p.goals, 2);
});
test('quantidades aceitam vírgula, milhar e conversão de unidade', () => {
  assert.equal(parseGoalAmount('2,5 L', 'ml'), 2500);
  assert.equal(parseGoalAmount('1.500', 'ml'), 1500);
  assert.equal(parseGoalAmount('500ml', 'ml'), 500);
  assert.equal(parseGoalAmount('1,5 h', 'min'), 90);
  assert.equal(parseGoalAmount('12', 'páginas'), 12);
  assert.throws(() => parseGoalAmount('2 km', 'ml'), /medida em ml/);
  assert.throws(() => parseGoalAmount('zero', 'ml'), /inválida/);
  assert.equal(formatAmount(2500, 'ml'), '2,5 L');
  assert.equal(formatAmount(1, 'vezes'), '1 vez');
});

function withGoal(g: Goal): State {
  const state = emptyState();
  state.goals = { goals: [g], logs: [] };
  return state;
}
const now = at('2026-09-20');
const run = (state: State, commands: Command[], when = now) =>
  execute(state, commands, 'web', when);

test('comandos: criar, registrar, status, pausar e retomar', () => {
  let state = emptyState();
  state.goals = { goals: [], logs: [] };
  let r = run(state, [
    { op: 'goal_create', title: 'Beber água', unit: 'ml', target: '2,5 L' },
    { op: 'goal_create', title: 'Treinar', period: 'weekly', target: '6' },
  ]);
  state = r.state;
  const [water, gym] = state.goals!.goals;
  assert.equal(water.icon, 'water');
  assert.deepEqual(water.quickAdds, [250, 500]);
  assert.equal(gym.kind, 'count');
  assert.equal(gym.countDays, true);
  assert.equal(gym.targets[0].from, '2026-09-14');
  r = run(state, [{ op: 'goal_log', goal: 'agua', amount: '2 L' }]);
  assert.match(r.reply, /Faltam 500 ml/);
  r = run(r.state, [{ op: 'goal_log', goal: 'agua', amount: '500' }]);
  assert.match(r.reply, /Meta cumprida! Ofensiva de 1 dia\./);
  state = r.state;
  r = run(state, [{ op: 'goal_log', goal: 'Treinar' }]);
  assert.match(r.reply, /1 vez de 6 vezes/);
  state = r.state;
  r = run(state, [{ op: 'goal_status' }]);
  assert.match(r.reply, /Beber água: 2,5 L de 2,5 L hoje, cumprida; ofensiva de 1 dia\./);
  assert.match(r.reply, /Dias perfeitos/);
  // Pausar no passado mudaria dias já fechados.
  assert.throws(
    () => run(state, [{ op: 'goal_pause', goal: 'Treinar', fromDate: '2026-09-10' }]),
    /dias já fechados/,
  );
  state = run(state, [{ op: 'goal_pause', goal: 'Treinar' }]).state;
  assert.equal(state.goals!.goals[1].pauses.length, 1);
  state = run(state, [{ op: 'goal_resume', goal: 'Treinar' }]).state;
  assert.equal(state.goals!.goals[1].pauses.length, 0);
});
test('registro só no dia aberto; ontem até as 12h; valor ausente vira pergunta', () => {
  let state = withGoal(goal());
  assert.throws(
    () => run(state, [{ op: 'goal_log', goal: 'Água', amount: '500', date: '2026-09-19' }]),
    /fechou às 12h/,
  );
  const morning = at('2026-09-20', 10);
  state = run(
    state,
    [{ op: 'goal_log', goal: 'Água', amount: '500', date: '2026-09-19' }],
    morning,
  ).state;
  assert.equal(state.goals!.logs[0].date, '2026-09-19');
  const asked = execute(state, [{ op: 'goal_log', goal: 'Água' }], 'web', morning);
  assert.equal(asked.clarification, true);
  const answer = pendingAnswer(asked.state, '750 ml', 'web', morning);
  assert.equal(answer?.[0].amount, '750 ml');
  // Registro de dia fechado não pode ser apagado.
  const old = state.goals!.logs[0].id;
  assert.throws(() => run(state, [{ op: 'goal_delete_log', entry: old }]), /já fechou/);
  const removed = run(state, [{ op: 'goal_delete_log', entry: old }], morning);
  assert.equal(removed.state.goals!.logs.length, 0);
});
test('meta ambígua pergunta qual; excluir pede confirmação', () => {
  const state = emptyState();
  state.goals = {
    goals: [goal(), goal({ title: 'Ler', unit: 'páginas' })],
    logs: [],
  };
  const which = run(state, [{ op: 'goal_log', amount: '10' }]);
  assert.equal(which.clarification, true);
  assert.match(which.reply, /1\. Água\n2\. Ler/);
  const choice = pendingAnswer(which.state, '2', 'web', now);
  assert.equal(choice?.[0].goal, state.goals.goals[1].id);
  const confirm = run(state, [{ op: 'goal_delete', goal: 'Ler' }]);
  assert.equal(confirm.clarification, true);
  const yes = pendingAnswer(confirm.state, 'sim', 'web', now)!;
  assert.equal(run(state, yes).state.goals!.goals.length, 1);
});

let database: Database;
before(async () => {
  database = await createDatabase();
});
after(async () => {
  await database.close();
});
test('banco: painel grava metas e registros, a leitura calcula a ofensiva e o backup leva tudo', async () => {
  const act = (commands: Command[]) => panelAction(commands, randomUUID(), database);
  await act([{ op: 'goal_create', title: 'Água', unit: 'ml', target: '2000' }]);
  const created = (await loadGoals(database)).goals[0];
  await act([{ op: 'goal_log', goal: created.id, amount: '2000' }]);
  const view = await goalsSnapshot(database);
  assert.equal(view.goals[0].progress.streak, 1);
  assert.equal(view.goals[0].logs.length, 1);
  assert.equal(view.perfect.today, 'met');
  // Registrar não enche o histórico de atividade.
  assert.equal((await snapshot(database)).history.filter((h) => /\+2 L/.test(h.action)).length, 0);
  const summary = await summarySnapshot({}, database);
  assert.equal(summary.goals[0].title, 'Água');

  const backup = await exportBackup(database);
  assert.equal(backup.version, 3);
  assert.equal(backup.goals.goals.length, 1);
  await act([{ op: 'goal_archive', goal: created.id }]);
  const revision = (await snapshot(database)).settings.revision;
  await importBackup(backup, revision, database);
  const restored = await loadGoals(database);
  assert.equal(restored.goals[0].archivedAt, null);
  assert.equal(restored.logs.length, 1);
});

test('avisos: no horário da meta se faltar algo, e às 21h com ofensiva de 3+ em risco', async () => {
  const { goalNotices } = await import('../src/backend/push');
  const { saveGoals } = await import('../src/backend/goals/store');
  const fresh = await createDatabase();
  try {
    const water = goal({ reminderTime: '08:00' });
    const logs = days('2026-09-01', 4).map((d) => log(water, d, 2500));
    await fresh.transaction((tx) =>
      saveGoals(tx, { goals: [], logs: [] }, { goals: [water], logs }),
    );
    // 08:05 em Salvador do dia 5: faltando tudo, avisa no horário.
    const morning = await goalNotices(fresh, Date.parse('2026-09-05T11:05:00Z'));
    assert.deepEqual(
      morning.map((n) => n.kind),
      ['reminder'],
    );
    assert.equal(morning[0].payload.body, 'Faltam 2,5 L em Água.');
    // 21:02: ofensiva de 4 dias em risco.
    const night = await goalNotices(fresh, Date.parse('2026-09-06T00:02:00Z'));
    assert.deepEqual(
      night.map((n) => n.kind),
      ['risk'],
    );
    assert.match(night[0].payload.body, /ofensiva de 4 dias está em risco/);
    // Cumprida, não avisa.
    const done = [...logs, log(water, '2026-09-05', 2500)];
    await fresh.transaction((tx) =>
      saveGoals(tx, { goals: [water], logs }, { goals: [water], logs: done }),
    );
    assert.equal((await goalNotices(fresh, Date.parse('2026-09-06T00:02:00Z'))).length, 0);
  } finally {
    await fresh.close();
  }
});

test('primeira semana pela metade não é anunciada como perdida', () => {
  // Meta criada na sexta: faltam 6 treinos e restam 3 dias, mas a semana ainda conta se cumprir.
  const g = goal({
    kind: 'count',
    unit: 'vezes',
    period: 'weekly',
    countDays: true,
    targets: [{ from: '2026-09-07', amount: 6 }],
    startDate: '2026-09-11',
  });
  assert.equal(evaluate(g, [], at('2026-09-11')).impossible, false);
});

test('mudar dias da semana ou a contagem por dia vale só daqui para frente', () => {
  // Meta de segunda a sexta cumprida em todos os dias úteis desde 01/09 (terça).
  const g = goal({ weekdays: [1, 2, 3, 4, 5] });
  const weekdaysOnly = days('2026-09-01', 17).filter((d) => {
    const day = new Date(`${d}T12:00:00Z`).getUTCDay();
    return day > 0 && day < 6;
  });
  const state = withGoal(g);
  state.goals!.logs = weekdaysOnly.map((d) => log(g, d, 2500));
  const when = at('2026-09-17');
  const before = evaluate(g, state.goals!.logs, when).streak;
  const after = run(state, [{ op: 'goal_update', goal: g.id, weekdays: [] }], when).state;
  const changed = after.goals!.goals[0];
  assert.equal(changed.weekdays, null);
  assert.equal(changed.schedules.length, 2);
  assert.equal(evaluate(changed, after.goals!.logs, when).streak, before);

  const gym = goal({
    kind: 'count',
    unit: 'vezes',
    period: 'weekly',
    countDays: false,
    targets: [{ from: '2026-08-31', amount: 3 }],
    startDate: '2026-08-31',
  });
  const gymState = withGoal(gym);
  // Três registros toda segunda: valem 3 contando cada registro.
  gymState.goals!.logs = ['2026-08-31', '2026-09-07', '2026-09-14'].flatMap((d) =>
    [1, 2, 3].map(() => log(gym, d, 1)),
  );
  const monday = at('2026-09-14');
  assert.equal(evaluate(gym, gymState.goals!.logs, monday).streak, 3);
  const counted = run(gymState, [{ op: 'goal_update', goal: gym.id, countDays: true }], monday)
    .state.goals!;
  assert.equal(evaluate(counted.goals[0], counted.logs, monday).streak, 2);
});
test('o que o chat grava cabe no schema do backup; sem metas, a resposta explica', () => {
  const state = emptyState();
  state.goals = { goals: [], logs: [] };
  assert.throws(
    () => run(state, [{ op: 'goal_create', title: 'x'.repeat(150), unit: 'ml', target: '1' }]),
    /até 100 caracteres/,
  );
  const tiny = run(state, [
    { op: 'goal_create', title: 'Água', unit: 'ml', target: '2000', quickAdds: [0.001, 250, 250] },
  ]).state;
  assert.deepEqual(tiny.goals!.goals[0].quickAdds, [250]);
  assert.throws(() => run(state, [{ op: 'goal_log', amount: '500 ml' }]), /ainda não tem metas/);
  // Meta arquivada não aceita registro nem pelo ID.
  const archived = run(tiny, [{ op: 'goal_archive', goal: 'Água' }]).state;
  assert.throws(
    () => run(archived, [{ op: 'goal_log', goal: archived.goals!.goals[0].id, amount: '1' }]),
    /arquivada/,
  );
});
