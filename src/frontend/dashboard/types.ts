import type { Command, Group, History, Task } from '@/backend/domain';

export type View =
  | 'goals'
  | 'notes'
  | 'summary'
  | 'finance'
  | 'assistant'
  | 'calendar'
  | 'archived'
  | 'all'
  | 'inbox'
  | 'today'
  | 'overdue'
  | 'no_date'
  | 'completed'
  | 'trash'
  | `group:${string}`;
export type Message = {
  id: string;
  channel: string;
  body: string | null;
  reply: string | null;
  status: string;
  error: string | null;
  created_at: string;
  // Etapa do pedido: 'reading' enquanto a IA interpreta e a agenda executa, 'writing' enquanto a
  // resposta é reescrita em linguagem natural.
  stage?: 'reading' | 'writing' | null;
};
export type Data = {
  tasks: Task[];
  groups: Group[];
  history: History[];
  settings: { retentionDays: number; revision: number; naturalReply: boolean };
  messages: Message[];
  llm: string;
  storage: string;
};
export type Modal =
  | { type: 'task'; task?: Task }
  | { type: 'group'; group?: Group }
  | { type: 'settings' }
  | { type: 'llm' }
  | { type: 'activity' }
  | { type: 'security' }
  | { type: 'backup' }
  | null;

export type Action = (commands: Command[], close?: boolean) => Promise<boolean>;
