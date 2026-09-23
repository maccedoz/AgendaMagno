import { categorySchema, entrySchema, planItemSchema, templateSchema } from './finance/types';
import { z } from 'zod';
import { db, loadState, lock, saveState, type Database } from './db';
import { DomainError, emptyState, normalize } from './domain';
import { checklistSchema, dateSchema, recurrenceSchema, tagsSchema } from './domain/types';
const timestamp = z.string().datetime();
const group = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    createdAt: timestamp,
    color: z.enum(['sage', 'blue', 'violet', 'amber', 'rose']).optional(),
    icon: z.enum(['folder', 'book', 'briefcase', 'home', 'heart', 'star']).optional(),
    order: z.number().int().min(0).max(10000).optional(),
    archivedAt: timestamp.nullable().optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .strict();
const task = z
  .object({
    id: z.number().int().positive().max(1e9),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000),
    groupId: z.string().uuid().nullable(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['low', 'normal', 'high']),
    dueDate: dateSchema.nullable(),
    dueTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    completedAt: timestamp.nullable(),
    trashedAt: timestamp.nullable(),
    purgeAt: timestamp.nullable(),
    trashReason: z.enum(['completed', 'discarded']).nullable(),
    version: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: tagsSchema.optional(),
    checklist: checklistSchema.optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    reminderMinutes: z.number().int().min(0).max(10080).nullable().optional(),
    recurringFrom: z.number().int().positive().optional(),
  })
  .strict();
const backupV1 = z
  .object({
    format: z.literal('AgendaMagno'),
    version: z.literal(1),
    createdAt: timestamp,
    groups: z.array(group).max(1000),
    tasks: z.array(task).max(10000),
    retentionDays: z.number().int().min(1).max(3650),
  })
  .strict();
const backupV2 = backupV1.extend({
  version: z.literal(2),
  finance: z
    .object({
      categories: z.array(categorySchema).max(1000),
      entries: z.array(entrySchema).max(10000),
      // Arquivos da versão 2 gerados antes dos modelos de lançamento não têm esta lista.
      templates: z.array(templateSchema).max(1000).default([]),
      // Sem a lista (arquivos anteriores ao planejamento), o planejamento atual é mantido.
      plan: z.array(planItemSchema).max(1000).optional(),
    })
    .strict(),
});
export const backupSchema = z.union([backupV1, backupV2]);
export async function exportBackup(connection?: Database) {
  const database = connection ?? (await db());
  return database.transaction(async (tx) => {
    await lock(tx);
    const state = await loadState(tx, true);
    return {
      format: 'AgendaMagno',
      version: 2,
      finance: state.finance,
      createdAt: new Date().toISOString(),
      groups: state.groups,
      tasks: state.tasks,
      retentionDays: state.settings.retentionDays,
    };
  });
}
export async function importBackup(
  input: unknown,
  expectedRevision: number,
  connection?: Database,
) {
  const value = backupSchema.parse(input);
  const ids = new Set(value.groups.map((g) => g.id));
  const names = new Set(value.groups.map((g) => normalize(g.name)));
  if (
    ids.size !== value.groups.length ||
    names.size !== value.groups.length ||
    new Set(value.tasks.map((t) => t.id)).size !== value.tasks.length
  )
    throw new DomainError('O arquivo contém grupos ou tarefas duplicados.');
  for (const task of value.tasks) {
    if (task.groupId && !ids.has(task.groupId))
      throw new DomainError('Uma tarefa aponta para um grupo inexistente.');
    if ((task.dueTime || task.recurrence || task.reminderMinutes != null) && !task.dueDate)
      throw new DomainError(
        'Uma tarefa precisa de data para seu horário, recorrência ou lembrete.',
      );
    if (
      Boolean(task.trashedAt) !== Boolean(task.purgeAt) ||
      (task.trashedAt && task.purgeAt! < task.trashedAt)
    )
      throw new DomainError('Datas de lixeira inconsistentes.');
    if (task.checklist && new Set(task.checklist.map((i) => i.id)).size !== task.checklist.length)
      throw new DomainError('Checklist com identificadores duplicados.');
  }
  if (value.version === 2) {
    const categories = value.finance.categories;
    const entries = value.finance.entries;
    if (
      new Set(categories.map((c) => c.id)).size !== categories.length ||
      new Set(categories.map((c) => normalize(c.name))).size !== categories.length ||
      new Set(entries.map((e) => e.id)).size !== entries.length
    )
      throw new DomainError('O arquivo contém categorias ou lançamentos duplicados.');
    if (new Set(value.finance.templates.map((t) => t.id)).size !== value.finance.templates.length)
      throw new DomainError('O arquivo contém modelos de lançamento duplicados.');
    const plan = value.finance.plan ?? [];
    const budgets = plan.filter((x) => x.kind === 'budget').map((x) => x.categoryId);
    if (
      new Set(plan.map((x) => x.id)).size !== plan.length ||
      new Set(budgets).size !== budgets.length
    )
      throw new DomainError('O arquivo contém itens de planejamento duplicados.');
    for (const item of plan) {
      const kind = item.categoryId && categories.find((c) => c.id === item.categoryId)?.kind;
      if (item.categoryId && (!kind || kind === 'income'))
        throw new DomainError('Categoria inexistente ou incompatível no planejamento.');
    }
    for (const entry of [...entries, ...value.finance.templates]) {
      const category = categories.find((c) => c.id === entry.categoryId);
      if (!category || (category.kind !== 'both' && category.kind !== entry.kind))
        throw new DomainError('Categoria inexistente ou incompatível no arquivo.');
      if (
        entry.updatedAt < entry.createdAt ||
        ('deletedAt' in entry && entry.deletedAt && entry.deletedAt < entry.createdAt)
      )
        throw new DomainError('Datas financeiras inconsistentes.');
    }
  }
  const database = connection ?? (await db());
  return database.transaction(async (tx) => {
    await lock(tx);
    const before = await loadState(tx);
    if (before.settings.revision !== expectedRevision)
      throw new DomainError('A agenda mudou. Atualize e revise a importação novamente.', 409);
    const state = emptyState();
    if (value.version === 2) state.finance = value.finance;
    state.groups = value.groups;
    state.tasks = value.tasks.map((t) =>
      t.trashReason === 'completed'
        ? { ...t, trashedAt: null, purgeAt: null, trashReason: null }
        : t,
    );
    state.settings = {
      financeInitialized: before.settings.financeInitialized,
      retentionDays: value.retentionDays,
      nextTaskId: Math.max(before.settings.nextTaskId, ...value.tasks.map((t) => t.id + 1)),
      revision: before.settings.revision + 1,
      // Preferência de redação deste aparelho, não conteúdo da agenda: o arquivo não a carrega
      // e restaurar tarefas não é motivo para religar uma chamada de IA que foi desligada.
      naturalReply: before.settings.naturalReply,
    };
    await saveState(tx, before, state);
    // Prevent an in-flight interpretation from applying actions against the replaced agenda.
    await tx.query(
      "UPDATE agenda_messages SET status='failed',lease_token=NULL,lease_until=NULL,body=NULL,reply=NULL,error=NULL WHERE channel IN ('web','panel')",
    );
    return { ok: true, tasks: state.tasks.length, groups: state.groups.length };
  });
}
