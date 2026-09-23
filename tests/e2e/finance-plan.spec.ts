import { test, expect } from '@playwright/test';
import { session } from './session';

test.beforeEach(async ({ browser, context }) => {
  await context.addCookies(await session(browser));
});

test('planejamento: renda, fixos e limite ficam fora do resultado real e avisam aos 80%', async ({
  page,
}) => {
  // O planejamento é único para a agenda inteira; nomes com sufixo evitam colisão entre
  // execuções no mesmo banco, e o final do teste remove o que criou.
  const tag = String(Date.now()).slice(-6);
  const salary = `Salário ${tag}`,
    rent = `Aluguel ${tag}`,
    category = `Mercado ${tag}`;
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Financeiro', exact: true })
    .click();
  await page.getByLabel('Mês', { exact: true }).selectOption('03');
  await page.getByLabel('Ano', { exact: true }).selectOption('2029');
  await page.getByText('Gerenciar categorias', { exact: true }).click();
  await page.getByRole('button', { name: 'Nova categoria', exact: true }).click();
  await page.getByLabel('Nome da categoria').fill(category);
  await page.getByRole('button', { name: 'Salvar categoria' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Novo lançamento', exact: true }).click();
  await page.getByLabel('Valor em reais').fill('85,00');
  await page.getByLabel('Data do lançamento').fill('2029-03-10');
  await page.getByLabel('Descrição do lançamento').fill(`Feira ${tag}`);
  await page.getByLabel('Categoria do lançamento').selectOption({ label: category });
  await page.getByRole('button', { name: 'Salvar lançamento' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByLabel('Resumo financeiro')).toContainText('85,00');

  await page.getByRole('tab', { name: 'Planejamento' }).click();
  await expect(page.getByText('não entra no saldo')).toBeVisible();
  await page.getByRole('button', { name: 'Nova renda' }).click();
  const incomeForm = page.getByRole('form', { name: 'Novo renda' });
  await incomeForm.getByLabel('Nome').fill(salary);
  await incomeForm.getByLabel('Valor por mês').fill('3.000,00');
  await incomeForm.getByRole('button', { name: 'Salvar renda' }).click();
  await page.getByRole('button', { name: 'Novo gasto fixo' }).click();
  const fixedForm = page.getByRole('form', { name: 'Novo gasto fixo' });
  await fixedForm.getByLabel('Nome').fill(rent);
  await fixedForm.getByLabel('Valor por mês').fill('1.200,00');
  await fixedForm.getByRole('button', { name: 'Salvar gasto fixo' }).click();
  await page.getByRole('button', { name: 'Novo limite' }).click();
  const budgetForm = page.getByRole('form', { name: 'Novo limite' });
  await budgetForm.getByLabel('Categoria').selectOption({ label: category });
  await budgetForm.getByLabel('Limite por mês').fill('100,00');
  await budgetForm.getByRole('button', { name: 'Salvar limite' }).click();

  const math = page.getByLabel('Cálculo planejado');
  await expect(math).toContainText('não é o saldo da conta');
  await expect(math.locator('.plan-subtotal').first()).toContainText('1.800,00');
  const budget = page.locator('.plan-budget').filter({ hasText: category });
  await expect(budget).toContainText('85%');
  await expect(budget).toHaveClass(/plan-warning/);
  await expect(budget).toContainText('Perto do limite');

  // O resultado real continua só com o lançamento.
  await page.getByRole('tab', { name: 'Lançamentos' }).click();
  await expect(page.getByLabel('Resumo financeiro')).not.toContainText('3.000,00');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Planejamento' }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole('button', { name: `Excluir limite de ${category}` }).click();
  await expect(budget).not.toBeVisible();
  await page.getByRole('button', { name: `Excluir ${rent}` }).click();
  await expect(page.getByText(rent, { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: `Excluir ${salary}` }).click();
  await expect(page.getByText(salary, { exact: true })).not.toBeVisible();
});
