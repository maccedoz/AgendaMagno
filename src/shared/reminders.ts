// Regra de quando uma tarefa lembra, usada pelo aviso da tela aberta e pelo envio por push.
// Fica fora de src/backend porque o navegador também a executa; só importa tipos.
import type { Group, Task } from '../backend/domain/types';

// Sem horário, a tarefa lembra às 09:00 de Brasília (-03:00, sem horário de verão).
export function reminderAt(task: Task) {
  if (
    !task.dueDate ||
    task.reminderMinutes == null ||
    task.trashedAt ||
    task.status === 'completed'
  )
    return null;
  return (
    new Date(`${task.dueDate}T${task.dueTime ?? '09:00'}:00-03:00`).getTime() -
    task.reminderMinutes * 60000
  );
}

// Janela do envio por push: lembretes vencidos há até 15 minutos. O agendador externo chama a
// varredura a cada 1–5 minutos; a folga cobre atrasos dele sem mandar aviso de horas atrás.
export const REMINDER_WINDOW_MS = 15 * 60000;

// A mesma tag no aviso da tela e no push faz o navegador substituir um pelo outro em silêncio,
// em vez de mostrar dois avisos no aparelho que recebeu os dois.
export const reminderTag = (taskId: number, at: number) => `agenda:reminder:${taskId}:${at}`;

// Lembretes vencidos há no máximo `windowMs`, fora de grupos arquivados. Tarefas com id
// negativo ainda não sincronizaram e só existem no navegador.
export function dueReminders(
  tasks: Task[],
  groups: Pick<Group, 'id' | 'archivedAt'>[],
  now: number,
  windowMs: number,
) {
  const archived = new Set(groups.filter((g) => g.archivedAt).map((g) => g.id));
  const due: { task: Task; at: number }[] = [];
  for (const task of tasks) {
    if (task.id < 0 || (task.groupId && archived.has(task.groupId))) continue;
    const at = reminderAt(task);
    if (at === null || at > now || now - at > windowMs) continue;
    due.push({ task, at });
  }
  return due;
}
