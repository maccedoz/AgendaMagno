// Formatação de metas compartilhada pelo servidor (respostas do chat, avisos) e pela tela.
// Sem dependências de Node: entra no pacote do navegador.
type Period = 'daily' | 'weekly' | 'monthly';
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const simple = (unit: string) => unit.trim().toLowerCase();
export function formatAmount(value: number, unit: string) {
  const u = simple(unit);
  if (u === 'ml' && value >= 1000) return `${number.format(value / 1000)} L`;
  if (u === 'vezes' || u === 'vez') return value === 1 ? '1 vez' : `${number.format(value)} vezes`;
  return `${number.format(value)} ${unit}`;
}
export const periodNoun: Record<Period, [string, string]> = {
  daily: ['dia', 'dias'],
  weekly: ['semana', 'semanas'],
  monthly: ['mês', 'meses'],
};
export const streakLabel = (streak: number, period: Period) =>
  `${streak} ${periodNoun[period][streak === 1 ? 0 : 1]}`;
