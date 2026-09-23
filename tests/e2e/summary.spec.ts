import { test, expect } from '@playwright/test';
import { session } from './session';

test.beforeEach(async ({ browser, context }) => {
  await context.addCookies(await session(browser));
});

test('resumo da semana mostra números, navega entre semanas e não avança além da atual', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Resumo da semana', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Resumo da semana', exact: true })).toBeVisible();
  await expect(page.getByLabel('Números da semana')).toContainText('Concluídas');
  await expect(page.getByLabel('Finanças da semana')).toContainText('R$');
  await expect(page.getByText('Semana atual', { exact: true })).toBeVisible();
  const next = page.getByRole('button', { name: 'Próxima semana', exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: 'Semana anterior', exact: true }).click();
  await expect(page.getByText('Semana atual', { exact: true })).not.toBeVisible();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByText('Semana atual', { exact: true })).toBeVisible();
});
