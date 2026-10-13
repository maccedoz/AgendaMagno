// Cálculo do planejamento, sem acesso a banco nem a módulos do Node: roda igual no servidor,
// nos testes e na tela.
import type { FinancePlanData, FinancePlanItem } from './types';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export type BudgetState = 'ok' | 'warning' | 'over';
export type BudgetRow = {
  categoryId: string;
  limit: number;
  fixed: number;
  spent: number;
  percent: number;
  state: BudgetState;
};
export type PlanSummary = {
  income: number;
  fixed: number;
  leftover: number;
  budgets: number;
  budgetsBeyondFixed: number;
  free: number;
  budgetRows: BudgetRow[];
  realIncome: number;
  realExpense: number;
  plannedExpense: number;
};

// Aviso a partir de 80% do limite; acima de 100% é estouro. Comparação em inteiros para que
// centavos não virem arredondamento de ponto flutuante na fronteira.
export function budgetState(spent: number, limit: number): BudgetState {
  if (spent > limit) return 'over';
  return spent * 5 >= limit * 4 ? 'warning' : 'ok';
}

export function planSummary(
  items: FinancePlanItem[],
  real: FinancePlanData['real'] = { income: 0, expense: 0, byCategory: [] },
): PlanSummary {
  const sum = (kind: FinancePlanItem['kind']) =>
    items.filter((x) => x.kind === kind).reduce((s, x) => s + x.amountCents, 0);
  const income = sum('income');
  const fixed = sum('fixed');
  const budgets = sum('budget');
  const fixedIn = (categoryId: string) =>
    items
      .filter((x) => x.kind === 'fixed' && x.categoryId === categoryId)
      .reduce((s, x) => s + x.amountCents, 0);
  const budgetRows = items
    .filter((x) => x.kind === 'budget' && x.categoryId)
    .map((x) => {
      const categoryId = x.categoryId!;
      const spent = real.byCategory.find((c) => c.id === categoryId)?.expense ?? 0;
      return {
        categoryId,
        limit: x.amountCents,
        fixed: fixedIn(categoryId),
        spent,
        percent: Math.round((spent * 100) / x.amountCents),
        state: budgetState(spent, x.amountCents),
      };
    });
  // O limite de uma categoria já cobre os gastos fixos dela (o aluguel entra no limite de
  // Moradia). Só a parte do limite que passa dos fixos reduz o que sobra, senão o aluguel
  // seria descontado duas vezes.
  const budgetsBeyondFixed = budgetRows.reduce((s, r) => s + Math.max(0, r.limit - r.fixed), 0);
  const leftover = income - fixed;
  return {
    income,
    fixed,
    leftover,
    budgets,
    budgetsBeyondFixed,
    free: leftover - budgetsBeyondFixed,
    budgetRows,
    realIncome: real.income,
    realExpense: real.expense,
    plannedExpense: fixed + budgetsBeyondFixed,
  };
}

// Quanto de cada gasto fixo já foi pago no mês. Um lançamento conta para o gasto fixo quando a
// descrição traz o nome dele (“Paguei aluguel” → Aluguel) ou, se o gasto tem categoria e é o
// único fixo dela, quando está nessa categoria. Cada lançamento conta uma vez só.
// Nomes compostos valem por inteiro e por parte: “YT + Meli + Spotify” reconhece qualquer um dos
// três, e “Internet(Móvel + Fixa)” reconhece “Internet” (o que vem entre parênteses só qualifica).
// Uma parte que serve a mais de um gasto fixo é ambígua e não conta para nenhum.
function phrases(name: string) {
  const whole = fold(name);
  const base = fold(name.replace(/\([^)]*\)/g, ' '));
  const parts = base.split(/[+/&,;]|\se\s/).map((x) => x.trim());
  return [...new Set([whole, base, ...parts])].filter((x) => x.length >= 2);
}
const mentions = (text: string, phrase: string) =>
  new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(
    text,
  );

export type FixedUsage = {
  item: FinancePlanItem;
  spent: number;
  percent: number;
  state: BudgetState;
  entries: FinancePlanData['expenseEntries'];
};
export function fixedUsage(
  items: FinancePlanItem[],
  entries: FinancePlanData['expenseEntries'],
): FixedUsage[] {
  const fixed = items.filter((x) => x.kind === 'fixed');
  const taken = new Set<string>();
  const claim = (match: (e: (typeof entries)[number]) => boolean) =>
    entries.filter((e) => !taken.has(e.id) && match(e));
  const all = new Map(fixed.map((x) => [x.id, phrases(x.name)]));
  const shared = (item: FinancePlanItem, phrase: string) =>
    fixed.some(
      (x) =>
        x.id !== item.id && (all.get(x.id)!.includes(phrase) || mentions(fold(x.name), phrase)),
    );
  const byName = new Map(
    fixed.map((item) => {
      const own = claim((e) => {
        const text = fold(e.description);
        return all.get(item.id)!.some((ph) => !shared(item, ph) && mentions(text, ph));
      });
      own.forEach((e) => taken.add(e.id));
      return [item.id, own] as const;
    }),
  );
  return fixed.map((item) => {
    const own = [...byName.get(item.id)!];
    const alone =
      item.categoryId !== null &&
      fixed.filter((x) => x.categoryId === item.categoryId).length === 1;
    if (alone) {
      const extra = claim((e) => e.categoryId === item.categoryId);
      extra.forEach((e) => taken.add(e.id));
      own.push(...extra);
    }
    own.sort((a, b) => a.date.localeCompare(b.date));
    const spent = own.reduce((s, e) => s + e.amountCents, 0);
    return {
      item,
      spent,
      entries: own,
      percent: Math.round((spent * 100) / item.amountCents),
      state: budgetState(spent, item.amountCents),
    };
  });
}
