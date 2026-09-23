import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { createDatabase, type Database } from '../src/backend/db';
import type { Task } from '../src/backend/domain';
import { panelAction } from '../src/backend/service';
import { sendTest, subscribe, sweepReminders, unsubscribe, type Sender } from '../src/backend/push';
import { dueReminders, reminderAt, REMINDER_WINDOW_MS } from '../src/shared/reminders';

let db: Database;
const keys = webpush.generateVAPIDKeys();
before(async () => {
  db = await createDatabase();
});
after(async () => {
  await db.close();
});
beforeEach(() => {
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:teste@example.com';
});

const task = (overrides: Partial<Task>): Task => ({
  id: 1,
  title: 'Tarefa',
  description: '',
  groupId: null,
  status: 'pending',
  priority: 'normal',
  dueDate: '2026-09-24',
  dueTime: '10:00',
  completedAt: null,
  trashedAt: null,
  purgeAt: null,
  trashReason: null,
  version: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  reminderMinutes: 30,
  ...overrides,
});
// 10:00 em Brasília com 30 minutos de antecedência: 12:30 UTC.
const at = Date.parse('2026-09-24T12:30:00.000Z');

test('lembrete sem horário usa 09:00 de Brasília e respeita a antecedência', () => {
  assert.equal(
    reminderAt(task({ dueTime: null, reminderMinutes: 0 })),
    Date.parse('2026-09-24T12:00:00Z'),
  );
  assert.equal(reminderAt(task({})), at);
  assert.equal(reminderAt(task({ reminderMinutes: null })), null);
  assert.equal(reminderAt(task({ status: 'completed' })), null);
  assert.equal(reminderAt(task({ trashedAt: '2026-09-02T00:00:00Z' })), null);
});

test('seleção de lembretes vencidos respeita a janela, grupos arquivados e tarefas locais', () => {
  const tasks = [
    task({ id: 1 }),
    task({ id: 2, groupId: 'arquivado' }),
    task({ id: 3, groupId: 'ativo' }),
    task({ id: -1 }),
    task({ id: 4, dueTime: '11:00' }),
  ];
  const groups = [
    { id: 'arquivado', archivedAt: '2026-09-01T00:00:00Z' },
    { id: 'ativo', archivedAt: null },
  ];
  const ids = (now: number) =>
    dueReminders(tasks, groups, now, REMINDER_WINDOW_MS).map((d) => d.task.id);
  assert.deepEqual(ids(at - 1000), []);
  assert.deepEqual(ids(at), [1, 3]);
  assert.deepEqual(ids(at + REMINDER_WINDOW_MS), [1, 3]);
  assert.deepEqual(ids(at + REMINDER_WINDOW_MS + 1), []);
  assert.deepEqual(ids(at + 3600000), [4]);
});

function recorder(fail?: (endpoint: string) => number | null) {
  const calls: { endpoint: string; payload: { title: string; body: string; tag: string } }[] = [];
  const send: Sender = async (subscription, payload) => {
    const status = fail?.(subscription.endpoint);
    if (status) throw Object.assign(new Error('push falhou'), { statusCode: status });
    calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  };
  return { calls, send };
}
const device = (name: string) => ({
  subscription: {
    endpoint: `https://push.example.com/${name}`,
    keys: { p256dh: 'chave-publica', auth: 'segredo' },
  },
});

test('varredura envia cada lembrete uma vez, remove inscrições expiradas e tenta de novo após falha', async () => {
  await panelAction(
    [
      {
        op: 'create_task',
        title: 'Dentista',
        dueDate: '2026-09-24',
        dueTime: '10:00',
        reminderMinutes: 30,
      },
      { op: 'create_task', title: 'Sem aviso', dueDate: '2026-09-24', dueTime: '10:00' },
      {
        op: 'create_task',
        title: 'Mais tarde',
        dueDate: '2026-09-24',
        dueTime: '18:00',
        reminderMinutes: 0,
      },
    ],
    randomUUID(),
    db,
  );
  // Sem aparelhos, nada é reservado: quem se inscrever depois ainda recebe dentro da janela.
  const empty = recorder();
  assert.equal((await sweepReminders(db, at + 60000, empty.send)).reminders, 0);

  await subscribe(device('notebook'), 'Notebook', db);
  await subscribe(device('celular'), 'Celular', db);
  await subscribe(device('celular'), 'Celular renomeado', db);
  const first = recorder();
  const result = await sweepReminders(db, at + 60000, first.send);
  assert.deepEqual(result, { configured: true, reminders: 1, sent: 2, failed: 0, removed: 0 });
  assert.deepEqual(first.calls.map((c) => c.endpoint).sort(), [
    'https://push.example.com/celular',
    'https://push.example.com/notebook',
  ]);
  assert.equal(first.calls[0].payload.body, 'Dentista');
  assert.equal(first.calls[0].payload.tag, `agenda:reminder:1:${at}`);

  const again = recorder();
  assert.equal((await sweepReminders(db, at + 120000, again.send)).reminders, 0);
  assert.equal(again.calls.length, 0);

  // 18:00 com antecedência zero: o celular expirou (410) e sai; o notebook falha de passagem,
  // então a reserva volta e a varredura seguinte reenvia.
  const evening = Date.parse('2026-09-24T21:00:00Z');
  const broken = recorder((endpoint) => (endpoint.endsWith('celular') ? 410 : 503));
  const failed = await sweepReminders(db, evening, broken.send);
  assert.deepEqual(failed, { configured: true, reminders: 1, sent: 0, failed: 1, removed: 1 });
  const left = await db.query<{ label: string; last_error: string }>(
    'SELECT label,last_error FROM agenda_push_subscriptions',
  );
  assert.deepEqual(left.rows, [{ label: 'Notebook', last_error: 'HTTP 503' }]);
  const retry = recorder();
  assert.equal((await sweepReminders(db, evening + 60000, retry.send)).sent, 1);
  assert.equal(retry.calls[0].payload.body, 'Mais tarde');

  const test1 = recorder();
  assert.equal(
    (await sendTest({ endpoint: 'https://push.example.com/notebook' }, db, test1.send)).sent,
    1,
  );
  await unsubscribe({ endpoint: 'https://push.example.com/notebook' }, db);
  await assert.rejects(sendTest({}, db, test1.send), /Nenhum aparelho/);
});

test('sem chaves VAPID a varredura não faz nada e a inscrição é recusada', async () => {
  delete process.env.VAPID_PRIVATE_KEY;
  const idle = recorder();
  assert.equal((await sweepReminders(db, at, idle.send)).configured, false);
  await assert.rejects(subscribe(device('outro'), 'Outro', db), /VAPID/);
});
