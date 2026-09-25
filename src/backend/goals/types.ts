import { z } from 'zod';
import { dateSchema } from '../domain/types';
import { GOAL_ICONS } from './icons';
export { GOAL_ICONS };
export type GoalIcon = (typeof GOAL_ICONS)[number];
export type GoalPeriod = 'daily' | 'weekly' | 'monthly';
// amount soma quantidades (ml, páginas, minutos); count soma vezes, cada registro vale 1 por
// padrão.
export type GoalKind = 'amount' | 'count';
export const MAX_GOAL_AMOUNT = 1_000_000;
// Quantidades com até duas casas: 2,5 L, 5,25 km. Guardadas como número e sempre
// arredondadas ao centésimo, para 0,1 + 0,2 não virar 0,30000000000000004 na soma.
export const round = (value: number) => Math.round(value * 100) / 100;
const amountSchema = z
  .number()
  .positive()
  .max(MAX_GOAL_AMOUNT)
  .refine((v) => Math.abs(round(v) - v) < 1e-9, 'Use no máximo duas casas decimais.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const goalSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(100),
    icon: z.enum(GOAL_ICONS),
    kind: z.enum(['amount', 'count']),
    unit: z.string().trim().min(1).max(20),
    period: z.enum(['daily', 'weekly', 'monthly']),
    // Só metas diárias: dias da semana em que a meta vale (0 = domingo). null = todos.
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable(),
    // Metas de vezes semanais ou mensais: true conta no máximo 1 por dia (dias com treino),
    // false conta cada registro (dois treinos no mesmo dia valem 2).
    countDays: z.boolean(),
    // Histórico de alvos: cada período é julgado pelo alvo que valia no seu início.
    targets: z
      .array(z.object({ from: dateSchema, amount: amountSchema }).strict())
      .min(1)
      .max(500),
    // Histórico de weekdays e countDays, como o dos alvos: mudar como a meta conta vale a partir
    // do período atual, e o passado continua julgado pela regra da época. Vazio = a regra atual
    // valeu desde o início.
    schedules: z
      .array(
        z
          .object({
            from: dateSchema,
            weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable(),
            countDays: z.boolean(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
    quickAdds: z.array(amountSchema).max(4),
    pauses: z.array(z.object({ from: dateSchema, to: dateSchema.nullable() }).strict()).max(200),
    reminderTime: time.nullable(),
    startDate: dateSchema,
    archivedAt: z.string().datetime().nullable(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Goal = z.infer<typeof goalSchema>;
export const goalLogSchema = z
  .object({
    id: z.string().uuid(),
    goalId: z.string().uuid(),
    date: dateSchema,
    amount: amountSchema,
    source: z.enum(['panel', 'web']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type GoalLog = z.infer<typeof goalLogSchema>;
export interface GoalState {
  goals: Goal[];
  logs: GoalLog[];
}

export type PeriodStatus = 'met' | 'missed' | 'frozen' | 'skipped' | 'open';
export interface PeriodResult {
  start: string;
  end: string;
  amount: number;
  target: number;
  status: PeriodStatus;
}
export interface GoalProgress {
  streak: number;
  best: number;
  freezes: number;
  current: PeriodResult;
  // Período anterior ainda aberto (o dia de ontem aceita registro até as 12h) e não cumprido.
  grace: PeriodResult | null;
  // Últimos períodos, do mais antigo ao atual, para a faixa do cartão.
  recent: PeriodResult[];
  // Ofensiva perdida no último período fechado, para avisar "a ofensiva de 12 dias acabou".
  lost: number | null;
  remaining: number;
  daysLeft: number;
  impossible: boolean;
}
export interface PerfectDays {
  streak: number;
  best: number;
  freezes: number;
  today: 'met' | 'open' | 'none';
  goals: number;
}
export interface GoalView extends Goal {
  progress: GoalProgress;
  // Registros que ainda podem ser corrigidos: os do período atual e os de ontem até as 12h.
  logs: GoalLog[];
}
export interface GoalsData {
  today: string;
  // Até esta hora de hoje (12h) o dia de ontem ainda aceita registro.
  graceDate: string | null;
  goals: GoalView[];
  perfect: PerfectDays;
}
