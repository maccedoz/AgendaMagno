import { test, expect } from '@playwright/test';
import { session } from './session';

test.beforeEach(async ({ browser, context }) => {
  await context.addCookies(await session(browser));
});

test('anotação guarda texto, anexa arquivo, encontra pela busca e some ao excluir', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Anotações', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Anotações', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nova anotação', exact: true }).click();
  // O editor é a página inteira: nada de janela, e a busca da lista sai de cena.
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByLabel('Buscar nas anotações')).not.toBeVisible();
  await page.getByLabel('Título').fill('Receita de bolo');
  await page.getByLabel('Texto').fill('Farinha e ovos');
  // Anexar numa anotação nova salva o texto primeiro, sem pedir um passo a mais.
  await page.getByLabel('Anexar arquivo').setInputFiles({
    name: 'lista.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('leite, açúcar, fermento'),
  });
  await expect(page.getByText('Anotação criada. lista.txt anexado.')).toBeVisible();
  const attached = page.locator('.note-file-row').filter({ hasText: 'lista.txt' });
  await expect(attached).toBeVisible();
  const download = page.waitForEvent('download');
  await attached.getByRole('button', { name: 'Baixar', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('lista.txt');
  await page.getByLabel('Texto').fill('Farinha, ovos e paciência');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.getByText('Anotação salva.')).toBeVisible();
  await page.getByRole('button', { name: 'Voltar para anotações', exact: true }).click();
  const card = page.locator('.note-card').filter({ hasText: 'Receita de bolo' });
  await expect(card).toContainText('1 arquivo(s)');

  await page.getByLabel('Buscar nas anotações').fill('paciência');
  await expect(card).toBeVisible();
  await page.getByLabel('Buscar nas anotações').fill('assunto que não existe');
  await expect(page.getByText('Nenhuma anotação para essa busca')).toBeVisible();
  await page.getByLabel('Buscar nas anotações').fill('');

  await card.click();
  await expect(page.getByLabel('Título')).toHaveValue('Receita de bolo');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Excluir anotação', exact: true }).click();
  await expect(card).not.toBeVisible();
});

test('modelo de lançamento preenche o formulário e não vira lançamento sozinho', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Financeiro', exact: true })
    .click();
  await page.getByLabel('Mês', { exact: true }).selectOption('03');
  await page.getByLabel('Ano', { exact: true }).selectOption('2030');
  await page.getByRole('button', { name: 'Novo modelo', exact: true }).click();
  await page.getByLabel('Nome do modelo').fill('Aluguel e2e');
  await page.getByLabel('Valor padrão em reais').fill('1.200,00');
  await page.getByLabel('Descrição padrão').fill('Aluguel do mês');
  await page.getByLabel('Categoria do modelo').selectOption({ label: 'Moradia' });
  await page.getByRole('button', { name: 'Salvar modelo' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  // Guardar o modelo não mexe no mês: o valor só entra quando a pessoa lança.
  await expect(page.getByLabel('Resumo financeiro')).toContainText('R$ 0,00');

  await page.getByRole('button', { name: 'Lançar Aluguel e2e', exact: true }).click();
  await expect(page.getByLabel('Valor em reais')).toHaveValue('1200,00');
  await expect(page.getByLabel('Descrição do lançamento')).toHaveValue('Aluguel do mês');
  await page.getByLabel('Data do lançamento').fill('2030-03-10');
  await page.getByRole('button', { name: 'Salvar lançamento' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByLabel('Resumo financeiro')).toContainText('1.200,00');
  await expect(page.getByRole('button', { name: 'Lançar Aluguel e2e', exact: true })).toBeVisible();
});
