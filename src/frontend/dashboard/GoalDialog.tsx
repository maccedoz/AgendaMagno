'use client';
import { useState, type FormEvent } from 'react';
import { Archive, Check, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import type { Command } from '@/backend/domain';
import { GOAL_ICONS } from '@/backend/goals/icons';
import type { GoalIcon, GoalPeriod, GoalView } from '@/backend/goals/types';
import { Dialog } from './Dialog';
import { goalIcons, perPeriod } from './Goals';

const ICON_LABELS: Record<GoalIcon, string> = {
  target: 'Alvo',
  water: 'Água',
  book: 'Leitura',
  dumbbell: 'Treino',
  run: 'Corrida',
  meditate: 'Mente',
  sleep: 'Sono',
  food: 'Alimentação',
  heart: 'Saúde',
  star: 'Estrela',
};
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
type Form = {
  title: string;
  kind: 'amount' | 'count';
  unit: string;
  target: string;
  period: GoalPeriod;
  weekdays: number[];
  countDays: boolean;
  quickAdds: string;
  reminderTime: string;
  icon: GoalIcon;
};
// Modelos para começar com um toque; tudo continua editável antes de criar.
const TEMPLATES: { label: string; form: Partial<Form> }[] = [
  {
    label: 'Água 2,5 L por dia',
    form: {
      title: 'Beber água',
      kind: 'amount',
      unit: 'ml',
      target: '2,5 L',
      period: 'daily',
      quickAdds: '250 500',
      icon: 'water',
    },
  },
  {
    label: 'Ler 10 páginas por dia',
    form: {
      title: 'Ler',
      kind: 'amount',
      unit: 'páginas',
      target: '10',
      period: 'daily',
      quickAdds: '5 10',
      icon: 'book',
    },
  },
  {
    label: 'Treinar 6x na semana',
    form: {
      title: 'Treinar',
      kind: 'count',
      target: '6',
      period: 'weekly',
      countDays: true,
      icon: 'dumbbell',
    },
  },
  {
    label: 'Meditar todo dia',
    form: { title: 'Meditar', kind: 'count', target: '1', period: 'daily', icon: 'meditate' },
  },
];
const number = (value: number) => String(value).replace('.', ',');
const parseQuick = (text: string) =>
  text
    .split(/[\s;]+/)
    .filter(Boolean)
    .map((v) => Number(v.replace(',', '.')))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, 4);

export function GoalDialog({
  goal,
  today,
  busy,
  act,
  close,
}: {
  goal?: GoalView;
  today: string;
  busy: boolean;
  act: (commands: Command[]) => Promise<boolean>;
  close: () => void;
}) {
  const [form, setForm] = useState<Form>(() => ({
    title: goal?.title ?? '',
    kind: goal?.kind ?? 'amount',
    unit: goal?.kind === 'count' ? '' : (goal?.unit ?? ''),
    target: goal ? number(goal.targets.at(-1)!.amount) : '',
    period: goal?.period ?? 'daily',
    weekdays: goal?.weekdays ?? [],
    countDays: goal?.countDays ?? true,
    quickAdds: goal?.quickAdds.map(number).join(' ') ?? '',
    reminderTime: goal?.reminderTime ?? '',
    icon: goal?.icon ?? 'target',
  }));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const paused = goal?.pauses.find((p) => (p.to ?? '9999-12-31') >= today);
  const version = goal ? { goal: goal.id, expectedVersion: goal.version } : {};
  async function submit(e: FormEvent) {
    e.preventDefault();
    const quickAdds = parseQuick(form.quickAdds);
    const daily = form.period === 'daily';
    const command: Command = goal
      ? {
          op: 'goal_update',
          ...version,
          title: form.title,
          goalIcon: form.icon,
          target: form.target,
          ...(goal.kind === 'amount' ? { quickAdds } : {}),
          reminderTime: form.reminderTime || null,
          ...(daily ? { weekdays: form.weekdays } : {}),
          ...(goal.kind === 'count' && !daily ? { countDays: form.countDays } : {}),
        }
      : {
          op: 'goal_create',
          title: form.title,
          goalKind: form.kind,
          ...(form.kind === 'amount' ? { unit: form.unit } : {}),
          target: form.target,
          period: form.period,
          goalIcon: form.icon,
          ...(daily && form.weekdays.length ? { weekdays: form.weekdays } : {}),
          ...(form.kind === 'count' && !daily ? { countDays: form.countDays } : {}),
          ...(quickAdds.length ? { quickAdds } : {}),
          ...(form.reminderTime ? { reminderTime: form.reminderTime } : {}),
        };
    if (await act([command])) close();
  }
  const unitLabel = form.kind === 'count' ? 'vezes' : form.unit || 'unidade';
  return (
    <Dialog
      title={goal ? `Meta: ${goal.title}` : 'Nova meta'}
      subtitle={
        goal
          ? 'Mudar o alvo vale a partir do período atual; o passado continua como foi.'
          : 'Um hábito com alvo por dia, semana ou mês. A ofensiva conta os períodos cumpridos seguidos.'
      }
      close={close}
    >
      <form className="editor-form goal-form" onSubmit={submit}>
        {!goal && (
          <div className="goal-templates" aria-label="Modelos de meta">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.label}
                className="chip-button"
                onClick={() =>
                  set({ weekdays: [], quickAdds: '', unit: '', countDays: true, ...t.form })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <fieldset disabled={busy}>
          <label htmlFor="goal-title">Nome da meta</label>
          <input
            id="goal-title"
            value={form.title}
            maxLength={100}
            required
            autoFocus
            placeholder="Ex.: Beber água"
            onChange={(e) => set({ title: e.target.value })}
          />
          {!goal && (
            <div className="goal-row">
              <label>
                Tipo
                <select
                  value={form.kind}
                  onChange={(e) => set({ kind: e.target.value as Form['kind'] })}
                >
                  <option value="amount">Quantidade (ml, páginas, minutos…)</option>
                  <option value="count">Vezes (treinos, sessões…)</option>
                </select>
              </label>
              <label>
                Período
                <select
                  value={form.period}
                  onChange={(e) => set({ period: e.target.value as GoalPeriod })}
                >
                  <option value="daily">Por dia</option>
                  <option value="weekly">Por semana</option>
                  <option value="monthly">Por mês</option>
                </select>
              </label>
            </div>
          )}
          <div className="goal-row">
            {!goal && form.kind === 'amount' && (
              <label>
                Unidade
                <input
                  list="goal-units"
                  value={form.unit}
                  maxLength={20}
                  required
                  placeholder="ml, páginas, min, km"
                  onChange={(e) => set({ unit: e.target.value })}
                />
                <datalist id="goal-units">
                  <option value="ml" />
                  <option value="páginas" />
                  <option value="min" />
                  <option value="km" />
                  <option value="passos" />
                </datalist>
              </label>
            )}
            <label>
              Alvo {perPeriod[goal?.period ?? form.period]} ({goal ? goal.unit : unitLabel})
              <input
                value={form.target}
                maxLength={40}
                required
                placeholder={form.kind === 'count' ? 'Ex.: 6' : 'Ex.: 2,5 L ou 2500'}
                onChange={(e) => set({ target: e.target.value })}
              />
            </label>
          </div>
          {(goal?.period ?? form.period) === 'daily' && (
            <div
              className="goal-weekdays"
              role="group"
              aria-label="Dias da semana em que a meta vale"
            >
              <span>Vale em</span>
              {WEEKDAYS.map((label, day) => (
                <label key={label} className="check-label">
                  <input
                    type="checkbox"
                    checked={!form.weekdays.length || form.weekdays.includes(day)}
                    onChange={(e) => {
                      const all = form.weekdays.length ? form.weekdays : [0, 1, 2, 3, 4, 5, 6];
                      const next = e.target.checked ? [...all, day] : all.filter((d) => d !== day);
                      // Pelo menos um dia: nenhum marcado seria salvo como "todos os dias".
                      if (!next.length) return;
                      set({ weekdays: next.length === 7 ? [] : [...new Set(next)].sort() });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          {(goal?.kind ?? form.kind) === 'count' && (goal?.period ?? form.period) !== 'daily' && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={form.countDays}
                onChange={(e) => set({ countDays: e.target.checked })}
              />
              Contar no máximo uma vez por dia (dois treinos no mesmo dia valem 1)
            </label>
          )}
          {(goal?.kind ?? form.kind) === 'amount' && (
            <>
              <label htmlFor="goal-quick">
                Botões de registro rápido (até 4, separados por espaço)
              </label>
              <input
                id="goal-quick"
                value={form.quickAdds}
                placeholder="Ex.: 250 500"
                onChange={(e) => set({ quickAdds: e.target.value })}
              />
            </>
          )}
          <div className="goal-row">
            <label>
              Lembrete por push
              <input
                type="time"
                value={form.reminderTime}
                onChange={(e) => set({ reminderTime: e.target.value })}
              />
            </label>
            <label>
              Ícone
              <select value={form.icon} onChange={(e) => set({ icon: e.target.value as GoalIcon })}>
                {GOAL_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {ICON_LABELS[icon]}
                  </option>
                ))}
              </select>
            </label>
            <span className="goal-icon preview" aria-hidden="true">
              {goalIcons[form.icon](20)}
            </span>
          </div>
          <small className="goal-hint">
            O lembrete chega no horário se a meta ainda não estiver cumprida (metas semanais e
            mensais, só quando o período apertar). Às 21h, ofensivas de 3 ou mais em risco também
            avisam.
          </small>
        </fieldset>
        {goal && (
          <div className="goal-manage">
            {!goal.archivedAt &&
              (paused ? (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => (await act([{ op: 'goal_resume', ...version }])) && close()}
                >
                  <Play size={15} /> Retomar
                </button>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => (await act([{ op: 'goal_pause', ...version }])) && close()}
                >
                  <Pause size={15} /> Pausar (férias, doença)
                </button>
              ))}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={async () =>
                (await act([
                  { op: goal.archivedAt ? 'goal_restore' : 'goal_archive', ...version },
                ])) && close()
              }
            >
              {goal.archivedAt ? <RotateCcw size={15} /> : <Archive size={15} />}
              {goal.archivedAt ? 'Reativar' : 'Arquivar'}
            </button>
            {confirmDelete ? (
              <span className="goal-confirm">
                Excluir a meta e todos os registros?
                <button
                  type="button"
                  className="button danger"
                  disabled={busy}
                  onClick={async () =>
                    (await act([{ op: 'goal_delete', ...version, confirmed: true }])) && close()
                  }
                >
                  Excluir de vez
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} /> Excluir
              </button>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <button className="button secondary push-right" type="button" onClick={close}>
            Fechar
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            <Check size={17} />
            {goal ? 'Salvar meta' : 'Criar meta'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
