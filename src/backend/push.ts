import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { z } from 'zod';
import { db, type Database } from './db';
import { DomainError, type Group, type Task } from './domain';
import { dueReminders, REMINDER_WINDOW_MS, reminderTag } from '../shared/reminders';
import { localDate } from './domain/format';
import { formatAmount, streakLabel } from './goals/rules';
import { loadGoals } from './goals/store';
import { countsDays, evaluate } from './goals/streak';
import { TIMEZONE } from './domain/types';

type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };
export type Payload = { title: string; body: string; tag: string; url: string };
// Injetável para os testes não falarem com o serviço de push de verdade.
export type Sender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export function vapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export async function pushInfo(connection?: Database) {
  const database = connection ?? (await db());
  const devices = await database.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM agenda_push_subscriptions',
  );
  return { publicKey: vapid()?.publicKey ?? null, devices: devices.rows[0]?.count ?? 0 };
}

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000).startsWith('https://'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export async function subscribe(input: unknown, label: string, connection?: Database) {
  if (!vapid())
    throw new DomainError('O servidor ainda não tem as chaves VAPID configuradas.', 503);
  const value = z.object({ subscription: subscriptionSchema }).parse(input).subscription;
  const database = connection ?? (await db());
  // O mesmo aparelho pode se inscrever de novo (chaves renovadas pelo navegador): o endpoint é
  // a identidade, e as chaves e o rótulo são atualizados.
  await database.query(
    `INSERT INTO agenda_push_subscriptions(id,endpoint,p256dh,auth,label) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth,
       label=EXCLUDED.label, last_error=NULL`,
    [randomUUID(), value.endpoint, value.keys.p256dh, value.keys.auth, label.slice(0, 120)],
  );
  return { ok: true };
}

export async function unsubscribe(input: unknown, connection?: Database) {
  const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(input);
  const database = connection ?? (await db());
  await database.query('DELETE FROM agenda_push_subscriptions WHERE endpoint=$1', [endpoint]);
  return { ok: true };
}

// Entrega um aviso a cada inscrição. 404/410 significam que o aparelho desfez a inscrição
// (ou o navegador a descartou): a linha sai do banco para não insistir para sempre.
async function deliver(
  database: Database,
  subscriptions: Subscription[],
  payload: Payload,
  send: Sender,
) {
  const keys = vapid();
  if (!keys) return { sent: 0, failed: 0, removed: 0 };
  let sent = 0;
  let failed = 0;
  let removed = 0;
  for (const sub of subscriptions) {
    try {
      await send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: keys,
          // Um aviso que ficou horas preso num aparelho desligado já perdeu o sentido.
          TTL: 6 * 3600,
          urgency: 'high',
          timeout: 10000,
        },
      );
      sent++;
      await database.query(
        'UPDATE agenda_push_subscriptions SET last_success_at=now(), last_error=NULL WHERE id=$1',
        [sub.id],
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        removed++;
        await database.query('DELETE FROM agenda_push_subscriptions WHERE id=$1', [sub.id]);
        continue;
      }
      failed++;
      await database.query(
        'UPDATE agenda_push_subscriptions SET last_failure_at=now(), last_error=$2 WHERE id=$1',
        [sub.id, status ? `HTTP ${status}` : ((error as Error).name ?? 'Erro').slice(0, 200)],
      );
    }
  }
  return { sent, failed, removed };
}

const defaultSender: Sender = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options);

async function subscriptions(database: Database, endpoint?: string) {
  return (
    await database.query<Subscription>(
      endpoint
        ? 'SELECT id,endpoint,p256dh,auth FROM agenda_push_subscriptions WHERE endpoint=$1'
        : 'SELECT id,endpoint,p256dh,auth FROM agenda_push_subscriptions ORDER BY created_at',
      endpoint ? [endpoint] : [],
    )
  ).rows;
}

export async function sendTest(input: unknown, connection?: Database, send = defaultSender) {
  if (!vapid())
    throw new DomainError('O servidor ainda não tem as chaves VAPID configuradas.', 503);
  const { endpoint } = z.object({ endpoint: z.string().max(2000).optional() }).parse(input);
  const database = connection ?? (await db());
  const targets = await subscriptions(database, endpoint);
  if (!targets.length)
    throw new DomainError('Nenhum aparelho inscrito. Ative os lembretes com o app fechado.', 404);
  const result = await deliver(
    database,
    targets,
    {
      title: 'AgendaMagna · Teste',
      body: 'Os lembretes com o app fechado estão funcionando neste aparelho.',
      tag: `agenda:test:${Date.now()}`,
      url: '/',
    },
    send,
  );
  if (!result.sent)
    throw new DomainError(
      result.removed
        ? 'O navegador desfez a inscrição deste aparelho. Ative os lembretes de novo.'
        : 'O serviço de push recusou o envio. Tente de novo em instantes.',
      502,
    );
  return result;
}

// Varredura chamada pelo agendador: acha lembretes vencidos na janela, reserva cada um em
// agenda_push_sent (a chave task_id + horário impede o reenvio, inclusive entre duas
// varreduras simultâneas) e entrega a todos os aparelhos inscritos.
export async function sweepReminders(
  connection?: Database,
  now = Date.now(),
  send = defaultSender,
) {
  if (!vapid()) return { configured: false, reminders: 0, sent: 0, failed: 0, removed: 0 };
  const database = connection ?? (await db());
  const totals = { configured: true, reminders: 0, sent: 0, failed: 0, removed: 0 };
  const targets = await subscriptions(database);
  // Sem aparelho inscrito não há o que reservar: quem se inscrever depois ainda recebe o que
  // estiver dentro da janela.
  if (!targets.length) return totals;
  const tasks = (
    await database.query<{ data: Task }>(
      `SELECT data FROM agenda_tasks WHERE data->>'dueDate' IS NOT NULL
         AND data->>'reminderMinutes' IS NOT NULL AND data->>'trashedAt' IS NULL
         AND data->>'status'<>'completed'`,
    )
  ).rows.map((r) => r.data);
  const groups = (await database.query<{ data: Group }>('SELECT data FROM agenda_groups')).rows.map(
    (r) => r.data,
  );
  for (const { task, at } of dueReminders(tasks, groups, now, REMINDER_WINDOW_MS)) {
    const claimed = await database.query(
      `INSERT INTO agenda_push_sent(task_id,reminder_at) VALUES($1,$2)
       ON CONFLICT DO NOTHING RETURNING task_id`,
      [task.id, new Date(at).toISOString()],
    );
    if (!claimed.rows.length) continue;
    totals.reminders++;
    const result = await deliver(
      database,
      targets,
      {
        title: 'AgendaMagna · Lembrete',
        body: task.title,
        tag: reminderTag(task.id, at),
        url: '/',
      },
      send,
    );
    totals.sent += result.sent;
    totals.failed += result.failed;
    totals.removed += result.removed;
    // Falha passageira em todos os aparelhos: devolve a reserva para a próxima varredura
    // tentar de novo enquanto o lembrete estiver na janela.
    if (!result.sent && result.failed)
      await database.query('DELETE FROM agenda_push_sent WHERE task_id=$1 AND reminder_at=$2', [
        task.id,
        new Date(at).toISOString(),
      ]);
  }
  for (const notice of await goalNotices(database, now)) {
    const claimed = await database.query(
      `INSERT INTO agenda_goal_push_sent(goal_id,day,kind) VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING goal_id`,
      [notice.goalId, notice.day, notice.kind],
    );
    if (!claimed.rows.length) continue;
    totals.reminders++;
    const result = await deliver(database, targets, notice.payload, send);
    totals.sent += result.sent;
    totals.failed += result.failed;
    totals.removed += result.removed;
    if (!result.sent && result.failed)
      await database.query(
        'DELETE FROM agenda_goal_push_sent WHERE goal_id=$1 AND day=$2 AND kind=$3',
        [notice.goalId, notice.day, notice.kind],
      );
  }
  await database.query("DELETE FROM agenda_push_sent WHERE sent_at < now() - interval '30 days'");
  await database.query(
    "DELETE FROM agenda_goal_push_sent WHERE sent_at < now() - interval '30 days'",
  );
  return totals;
}

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
// Às 21h, quem tem ofensiva de 3 ou mais em risco recebe o aviso de que ela acaba à meia-noite.
export const RISK_TIME = '21:00';
const RISK_MINIMUM = 3;
// Avisos de metas: no horário escolhido da meta, se o período ainda não foi cumprido, e às 21h
// para ofensivas em risco. Metas semanais e mensais só avisam quando o período aperta (cada dia
// restante é necessário) ou no último dia.
export async function goalNotices(database: Database, now = Date.now()) {
  const date = new Date(now);
  const current = minutes(clock.format(date));
  const due = (time: string) =>
    current >= minutes(time) && (current - minutes(time)) * 60000 <= REMINDER_WINDOW_MS;
  const data = await loadGoals(database);
  const day = localDate(date);
  const notices: { goalId: string; day: string; kind: string; payload: Payload }[] = [];
  for (const goal of data.goals) {
    if (goal.archivedAt) continue;
    const p = evaluate(goal, data.logs, date);
    if (p.current.status !== 'open' || p.impossible) continue;
    const byDays = countsDays(goal, p.current.start);
    // Apertado: cada dia que resta precisa de registro (hoje só conta se ainda não houve).
    const loggedToday = data.logs.some((l) => l.goalId === goal.id && l.date === day);
    const tight =
      goal.period === 'daily' ||
      p.daysLeft === 1 ||
      (byDays && p.remaining >= p.daysLeft - (loggedToday ? 1 : 0));
    const left = `Faltam ${formatAmount(p.remaining, goal.unit)} em ${goal.title}.`;
    if (goal.reminderTime && tight && due(goal.reminderTime))
      notices.push({
        goalId: goal.id,
        day,
        kind: 'reminder',
        payload: {
          title: 'AgendaMagna · Meta',
          body: left,
          tag: `agenda:goal:${goal.id}:${day}`,
          url: '/',
        },
      });
    // Com congelamento guardado a ofensiva não cai hoje: não há risco para avisar.
    if (
      p.streak >= RISK_MINIMUM &&
      p.freezes === 0 &&
      (goal.period === 'daily' || p.daysLeft === 1) &&
      due(RISK_TIME)
    )
      notices.push({
        goalId: goal.id,
        day,
        kind: 'risk',
        payload: {
          title: 'AgendaMagna · Ofensiva em risco',
          body: `Sua ofensiva de ${streakLabel(p.streak, goal.period)} está em risco. ${left}`,
          tag: `agenda:goal-risk:${goal.id}:${day}`,
          url: '/',
        },
      });
  }
  return notices;
}
