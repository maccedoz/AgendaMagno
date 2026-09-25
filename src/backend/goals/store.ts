import type { Database, Sql } from '../db';
import { db } from '../db';
import { localDate } from '../domain/format';
import { graceDate, openDates } from './dates';
import { evaluate, perfectDays } from './streak';
import type { Goal, GoalLog, GoalState, GoalsData } from './types';

// Uma consulta só, como loadState e loadFinance: cada ida ao Neon é uma viagem de rede.
export async function loadGoals(sql: Sql): Promise<GoalState> {
  const row = (
    await sql.query<GoalState>(
      `SELECT (SELECT COALESCE(jsonb_agg(data ORDER BY id), '[]'::jsonb) FROM agenda_goals) AS "goals",
        (SELECT COALESCE(jsonb_agg(data ORDER BY date, id), '[]'::jsonb) FROM agenda_goal_logs) AS "logs"`,
    )
  ).rows[0];
  return row;
}
// Para o interpretador: só as metas ativas, sem registros.
export async function goalsContext(sql: Sql) {
  return (
    await sql.query<{ data: Goal }>(
      "SELECT data FROM agenda_goals WHERE data->>'archivedAt' IS NULL ORDER BY data->>'title'",
    )
  ).rows.map(({ data: g }) => ({
    id: g.id,
    title: g.title,
    kind: g.kind,
    unit: g.unit,
    period: g.period,
  }));
}
export async function saveGoals(tx: Sql, before: GoalState, after: GoalState) {
  const oldGoals = new Map(before.goals.map((g) => [g.id, JSON.stringify(g)]));
  for (const goal of after.goals) {
    const json = JSON.stringify(goal);
    if (oldGoals.get(goal.id) !== json)
      await tx.query(
        'INSERT INTO agenda_goals(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        [goal.id, json],
      );
    oldGoals.delete(goal.id);
  }
  for (const id of oldGoals.keys()) await tx.query('DELETE FROM agenda_goals WHERE id=$1', [id]);
  // Registros não mudam depois de criados: só entram ou saem.
  const oldLogs = new Set(before.logs.map((l) => l.id));
  for (const log of after.logs) {
    if (!oldLogs.delete(log.id))
      await tx.query(
        'INSERT INTO agenda_goal_logs(id,goal_id,date,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO NOTHING',
        [log.id, log.goalId, log.date, JSON.stringify(log)],
      );
  }
  for (const id of oldLogs) await tx.query('DELETE FROM agenda_goal_logs WHERE id=$1', [id]);
}

// Leitura da aba Metas: sem a trava da agenda. As ofensivas são calculadas aqui, a partir dos
// registros, com as mesmas funções que respondem no chat.
export function goalsView(state: GoalState, now = new Date()): GoalsData {
  const open = openDates(now);
  const byGoal = new Map<string, GoalLog[]>();
  for (const log of state.logs) byGoal.set(log.goalId, [...(byGoal.get(log.goalId) ?? []), log]);
  const views = state.goals.map((goal: Goal) => {
    const logs = byGoal.get(goal.id) ?? [];
    const progress = evaluate(goal, logs, now);
    return {
      ...goal,
      progress,
      logs: logs
        .filter(
          (l) =>
            open.includes(l.date) ||
            (l.date >= progress.current.start && l.date <= progress.current.end),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50),
    };
  });
  return {
    today: localDate(now),
    graceDate: graceDate(now),
    goals: views,
    perfect: perfectDays(state.goals, state.logs, now),
  };
}
export async function goalsSnapshot(connection?: Database, now = new Date()): Promise<GoalsData> {
  const database = connection ?? (await db());
  return goalsView(await loadGoals(database), now);
}
