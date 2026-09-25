import { localDate } from '../domain/format';
import { TIMEZONE } from '../domain/types';
import type { GoalPeriod } from './types';

// Datas em YYYY-MM-DD, sempre no dia local da Bahia. Meio-dia UTC como âncora: somar dias ou
// ler o dia da semana nunca escorrega para a data vizinha por causa do fuso do servidor.
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
// Semana de segunda a domingo, como no Resumo da semana.
export const weekStart = (date: string) => addDays(date, -((weekday(date) + 6) % 7));
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
export function monthEnd(date: string) {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
}
export function periodStart(period: GoalPeriod, date: string) {
  return period === 'daily' ? date : period === 'weekly' ? weekStart(date) : monthStart(date);
}
export function periodEnd(period: GoalPeriod, start: string) {
  return period === 'daily' ? start : period === 'weekly' ? addDays(start, 6) : monthEnd(start);
}
export function nextPeriod(period: GoalPeriod, start: string) {
  return addDays(periodEnd(period, start), 1);
}
const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});
export const localHour = (now: Date) => Number(hourFormat.format(now));
// Até as 12h o dia anterior ainda aceita registro: quem bebeu água às 23h e só anotou de manhã
// não perde a ofensiva por isso.
export const GRACE_HOUR = 12;
export function graceDate(now: Date) {
  return localHour(now) < GRACE_HOUR ? addDays(localDate(now), -1) : null;
}
export function openDates(now: Date) {
  const today = localDate(now);
  const grace = graceDate(now);
  return grace ? [grace, today] : [today];
}
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}
