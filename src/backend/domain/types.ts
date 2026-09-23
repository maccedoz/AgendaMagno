import { z } from 'zod';
import type { FinanceState } from '../finance/types';

export const TIMEZONE = 'America/Bahia';
export type Status = 'pending' | 'in_progress' | 'completed';
export type Priority = 'low' | 'normal' | 'high';
export interface Group {
  id: string;
  name: string;
  createdAt: string;
  color?: string;
  icon?: string;
  order?: number;
  archivedAt?: string | null;
  version?: number;
}
export interface Task {
  id: number;
  title: string;
  description: string;
  groupId: string | null;
  status: Status;
  priority: Priority;
  dueDate: string | null;
  dueTime: string | null;
  completedAt: string | null;
  trashedAt: string | null;
  purgeAt: string | null;
  trashReason: 'completed' | 'discarded' | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  checklist?: { id: string; title: string; done: boolean }[];
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    interval: number;
    weekdays?: number[];
    monthDay?: number;
  } | null;
  reminderMinutes?: number | null;
  recurringFrom?: number;
}
export interface History {
  id: string;
  taskId: number;
  action: string;
  source: string;
  at: string;
}
export interface Change {
  taskId: number;
  before: Task | null;
  afterVersion: number;
}
export interface Operation {
  id: string;
  sequence: number;
  channel: string;
  at: string;
  changes: Change[];
  undoable: boolean;
  undone: boolean;
  groupChanges?: { id: string; before: Group | null; after: Group | null }[];
}
// Campo do comando que a resposta da pessoa vai preencher. 'deleteTasks' é booleano, e por
// isso a escolha guarda 'true'/'false' em texto e é convertida ao retomar o pedido.
export type PendingField =
  | 'task'
  | 'group'
  | 'deleteTasks'
  | 'entry'
  | 'category'
  | 'amount'
  | 'kind'
  | 'description'
  | 'confirmed';
export interface PendingOption {
  ref: string;
  label: string;
  // Respostas em palavras que valem por esta opção, além do número. Sem elas, responder
  // “excluídas” a uma pergunta de duas opções não seria reconhecido como resposta, e o pedido
  // original se perderia.
  keywords?: string[];
}
export interface Conversation {
  id: string;
  groupId: string | null;
  taskIds: number[];
  expiresAt: string;
  pending?: {
    commands: Command[];
    index: number;
    field: PendingField;
    options: PendingOption[];
    createGroup?: string;
    question?: string;
  };
  lastQuery?: Command;
}
export interface State {
  finance?: FinanceState;
  tasks: Task[];
  groups: Group[];
  history: History[];
  operations: Operation[];
  conversations: Conversation[];
  settings: {
    financeInitialized?: boolean;
    retentionDays: number;
    nextTaskId: number;
    revision: number;
    // Segunda chamada à IA que reescreve a resposta pronta em linguagem natural. Ausente
    // significa ligada: bancos criados antes desta versão não têm o campo.
    naturalReply?: boolean;
  };
}
export function emptyState(): State {
  return {
    tasks: [],
    groups: [],
    history: [],
    operations: [],
    conversations: [],
    settings: {
      retentionDays: 30,
      nextTaskId: 1,
      revision: 0,
    },
  };
}
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Data inválida');
export const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(365),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    monthDay: z.number().int().min(1).max(31).optional(),
  })
  .strict();
export const checklistSchema = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      })
      .strict(),
  )
  .max(100);
export const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20);
export const commandSchema = z
  .object({
    op: z.enum([
      'finance_create',
      'finance_update',
      'finance_delete',
      'finance_restore',
      'finance_list',
      'finance_create_template',
      'finance_update_template',
      'finance_delete_template',
      'finance_create_category',
      'finance_update_category',
      'finance_archive_category',
      'finance_restore_category',
      'create_group',
      'rename_group',
      'update_group',
      'delete_group',
      'archive_group',
      'restore_group',
      'list_groups',
      'create_task',
      'update_task',
      'complete_task',
      'trash_task',
      'restore_task',
      'list_tasks',
      'details',
      'settings',
      'set_retention',
      'set_natural_reply',
      'week_summary',
      'undo',
      'help',
      'clarify',
      'unsupported',
    ]),
    entry: z.string().min(1).max(5000).optional(),
    template: z.string().min(1).max(200).optional(),
    category: z.string().min(1).max(100).optional(),
    kind: z.enum(['income', 'expense']).optional(),
    categoryKind: z.enum(['income', 'expense', 'both']).optional(),
    amount: z.string().min(1).max(40).optional(),
    date: dateSchema.optional(),
    confirmed: z.boolean().optional(),
    task: z.string().min(1).max(200).optional(),
    group: z.string().min(1).max(100).nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(5000).optional(),
    appendDescription: z.string().max(5000).optional(),
    status: z.enum(['pending', 'in_progress']).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    dueDate: dateSchema.nullable().optional(),
    fromDate: dateSchema.optional(),
    toDate: dateSchema.optional(),
    tag: z.string().max(40).optional(),
    tags: tagsSchema.optional(),
    checklist: checklistSchema.optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    reminderMinutes: z.number().int().min(0).max(10080).nullable().optional(),
    color: z.enum(['sage', 'blue', 'violet', 'amber', 'rose']).optional(),
    icon: z.enum(['folder', 'book', 'briefcase', 'home', 'heart', 'star']).optional(),
    order: z.number().int().min(0).max(10000).optional(),
    deleteTasks: z.boolean().optional(),
    enabled: z.boolean().optional(),
    dueTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    filter: z
      .enum(['active', 'today', 'overdue', 'no_date', 'trash', 'completed', 'all'])
      .optional(),
    search: z.string().max(200).optional(),
    page: z.number().int().min(1).max(10000).optional(),
    days: z.number().int().min(1).max(3650).optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
    question: z.string().min(1).max(600).optional(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export const commandsSchema = z.array(commandSchema).min(1).max(10);
export const panelCommandsSchema = z.array(commandSchema).min(1).max(100);
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
// Thrown by the lookup helpers when a command's task/group reference doesn't resolve to
// exactly one match. Caught by execute() to turn it into a clarification reply instead of
// a hard failure, without applying any of the command's siblings.
export class Ambiguity extends DomainError {
  constructor(
    message: string,
    public field: PendingField,
    public options: PendingOption[],
    public createGroup?: string,
  ) {
    super(message);
  }
}
