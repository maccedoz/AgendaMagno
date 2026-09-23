import type { Command } from '@/backend/domain';
import type { Data } from './types';
export type Pending = { id: string; commands: Command[]; at: string };
type Saved = { data: Data; expiresAt: string };
const DB = 'agendamagno-offline';
export const offlineEnabled = () => localStorage.getItem('agenda:offline-enabled') === 'true';
async function access<T>(key: string, value?: T, remove = false): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('data');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const connection = open.result;
      const tx = connection.transaction(
        'data',
        value !== undefined || remove ? 'readwrite' : 'readonly',
      );
      const store = tx.objectStore('data');
      const request = remove
        ? store.delete(key)
        : value !== undefined
          ? store.put(value, key)
          : store.get(key);
      tx.oncomplete = () => {
        connection.close();
        resolve(request.result as T);
      };
      tx.onerror = () => {
        connection.close();
        reject(tx.error);
      };
    };
  });
}
export async function remember(data: Data) {
  if (!offlineEnabled()) return;
  const expiresAt =
    sessionStorage.getItem('agenda:expires') ?? localStorage.getItem('agenda:expires');
  // Conversas podem conter finanças; o modo offline guarda somente dados de tarefas.
  const taskData = { ...data, messages: [], history: data.history.filter((h) => h.taskId > 0) };
  if (expiresAt) await access('snapshot', { data: taskData, expiresAt });
}
export async function cached() {
  if (!offlineEnabled()) return null;
  const saved = await access<Saved>('snapshot');
  if (!saved || Date.parse(saved.expiresAt) <= Date.now()) {
    await clearOffline();
    return null;
  }
  return saved.data;
}
export async function pending() {
  return offlineEnabled() ? ((await access<Pending[]>('queue')) ?? []) : [];
}
export async function setPending(items: Pending[]) {
  await access('queue', items);
}
export async function clearOffline() {
  await access('snapshot', undefined, true);
  await access('queue', undefined, true);
}
export function project(data: Data, queue: Pending[]): Data {
  const result = structuredClone(data);
  let temporary = -1;
  for (const item of queue)
    for (const c of item.commands) {
      const time = item.at;
      if (c.op === 'create_task') {
        result.tasks.push({
          id: temporary--,
          title: c.title ?? '',
          description: c.description ?? '',
          groupId: c.group ?? null,
          status: c.status ?? 'pending',
          priority: c.priority ?? 'normal',
          dueDate: c.dueDate ?? null,
          dueTime: c.dueTime ?? null,
          tags: c.tags,
          checklist: c.checklist,
          recurrence: c.recurrence,
          reminderMinutes: c.reminderMinutes,
          completedAt: null,
          trashedAt: null,
          purgeAt: null,
          trashReason: null,
          createdAt: time,
          updatedAt: time,
          version: 1,
        });
        continue;
      }
      const task = result.tasks.find((t) => `#${t.id}` === c.task);
      if (!task) continue;
      if (c.op === 'update_task') {
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
        ] as const)
          if (c[key] !== undefined) Object.assign(task, { [key]: c[key] });
        if (c.group !== undefined) task.groupId = c.group;
        if (c.dueDate === null) task.dueTime = null;
      } else if (c.op === 'complete_task') {
        task.status = 'completed';
        task.completedAt = time;
      } else if (c.op === 'trash_task') {
        task.trashedAt = time;
        task.trashReason = 'discarded';
        task.purgeAt = new Date(
          Date.parse(time) + result.settings.retentionDays * 86400000,
        ).toISOString();
      } else if (c.op === 'restore_task') {
        task.status = 'pending';
        task.completedAt = task.trashedAt = task.purgeAt = task.trashReason = null;
      }
      task.version++;
      task.updatedAt = time;
    }
  return result;
}
export async function enqueue(commands: Command[], id: string) {
  if (!offlineEnabled())
    throw new Error('Ative o modo offline nas configurações antes de usar sem internet.');
  if (
    commands.some(
      (c) =>
        !['create_task', 'update_task', 'complete_task', 'trash_task', 'restore_task'].includes(
          c.op,
        ),
    )
  )
    throw new Error(
      'Esta operação exige internet. No modo offline, você pode criar e editar tarefas.',
    );
  if (commands.some((c) => c.task?.startsWith('#-')))
    throw new Error('Aguarde a sincronização desta tarefa nova antes de editá-la.');
  const queue = await pending();
  if (!queue.some((item) => item.id === id))
    queue.push({ commands, id, at: new Date().toISOString() });
  if (queue.length > 100)
    throw new Error('Sincronize as 100 alterações pendentes antes de continuar.');
  await setPending(queue);
}
export async function registerWorker() {
  if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
}
export { reminderAt } from '@/shared/reminders';

export async function queueLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request('agendamagno-queue', fn) : fn();
}
