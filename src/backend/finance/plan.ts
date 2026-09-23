// Cálculo do planejamento, sem acesso a banco nem a módulos do Node: roda igual no servidor,
// nos testes e na tela.
import type { FinancePlanData, FinancePlanItem } from './types';

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
