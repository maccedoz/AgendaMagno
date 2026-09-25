import { test, expect } from '@playwright/test';
import { session } from './session';

test.beforeEach(async ({ browser, context }) => {
  await context.addCookies(await session(browser));
});

test('meta de água: cria pelo modelo, registra com um toque, cumpre e acende a ofensiva', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Metas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Metas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nova meta', exact: true }).click();
  await page.getByRole('button', { name: 'Água 2,5 L por dia' }).click();
  await expect(page.getByLabel('Nome da meta')).toHaveValue('Beber água');
  await page.getByRole('button', { name: 'Criar meta' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  const card = page.locator('.goal-card').filter({ hasText: 'Beber água' });
  await expect(card).toContainText('0 ml de 2,5 L hoje');
  await expect(card).toContainText('Em andamento');
  await card.getByRole('button', { name: '+500 ml' }).click();
  await expect(card).toContainText('500 ml de 2,5 L hoje');
  await card.getByLabel('Outra quantidade para Beber água').fill('2 L');
  await card.getByRole('button', { name: 'Registrar' }).click();
  await expect(card).toContainText('Cumprida');
  await expect(card.locator('.goal-flame strong')).toHaveText('1');
  await expect(page.getByLabel('Dias perfeitos')).toContainText('1 dia perfeito');

  // Registro errado sai pela lista de registros do dia.
  await card.getByText(/Registros recentes/).click();
  await card.getByRole('button', { name: 'Remover registro de 2 L' }).click();
  await expect(card).toContainText('500 ml de 2,5 L hoje');
  await expect(card).toContainText('Em andamento');

  // Semanal de vezes pelo formulário.
  await page.getByRole('button', { name: 'Nova meta', exact: true }).click();
  await page.getByRole('button', { name: 'Treinar 6x na semana' }).click();
  await page.getByRole('button', { name: 'Criar meta' }).click();
  const gym = page.locator('.goal-card').filter({ hasText: 'Treinar' });
  await gym.getByRole('button', { name: '+1' }).click();
  await expect(gym).toContainText('1 vez de 6 vezes nesta semana');

  // Sem IA, "metas" no chat responde com o status calculado pela agenda.
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Assistente', exact: true })
    .click();
  await page.getByLabel('Sua mensagem').fill('metas');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.locator('.bubble.assistant').last()).toContainText('Treinar: 1 vez de 6 vezes');
  await page.screenshot({ path: 'test-results/goals-chat.png', fullPage: true });
});
