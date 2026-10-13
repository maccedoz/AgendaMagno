import { test, expect } from '@playwright/test';

test('painel completo: login, grupo, tarefa, edição, conclusão, restauração e conversa', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Sua senha').fill('wrong');
  await page.getByRole('button', { name: 'Entrar no meu espaço' }).click();
  await expect(page.getByText('Senha incorreta.')).toBeVisible();
  await page.getByLabel('Sua senha').fill('test-password-only');
  await page.getByRole('button', { name: 'Entrar no meu espaço' }).click();
  // A conversa com o assistente é a tela inicial; o painel fica a um clique na navegação.
  await expect(page.getByLabel('Sua mensagem')).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Todas as tarefas/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Todas as tarefas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Criar grupo', exact: true }).click();
  await page.getByLabel('Nome do grupo').fill('Estudos');
  await page.getByRole('dialog').getByRole('button', { name: 'Criar grupo', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Nova tarefa', exact: true }).click();
  await page.getByLabel('O que você precisa fazer?').fill('Revisar derivadas');
  await page.getByLabel('Descrição', { exact: false }).fill('Resolver as questões pares.');
  await page.getByLabel('Grupo', { exact: true }).selectOption({ label: 'Estudos' });
  await page.getByLabel('Prioridade', { exact: true }).selectOption('high');
  await page.getByLabel('Data de entrega').fill('2026-09-20');
  await page.getByRole('button', { name: 'Criar tarefa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Editar Revisar derivadas' })).toBeVisible();
  await page.getByRole('button', { name: 'Editar Revisar derivadas' }).click();
  await page.getByLabel('O que você precisa fazer?').fill('Revisar limites');
  await page.getByLabel('Situação', { exact: true }).selectOption('in_progress');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByRole('button', { name: 'Editar Revisar limites' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Concluir Revisar limites' }).click();
  await expect(page.getByRole('button', { name: 'Editar Revisar limites' })).not.toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Concluídas/ })
    .click();
  await expect(page.getByRole('button', { name: 'Restaurar Revisar limites' })).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar Revisar limites' }).click();
  await page.getByRole('button', { name: /^Todas as tarefas/ }).click();
  await expect(page.getByRole('button', { name: 'Editar Revisar limites' })).toBeVisible();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByLabel('Excluir após quantos dias?').fill('7');
  // A tecla de envio vale na hora, sem depender de salvar as preferências.
  await expect(page.getByLabel('Ctrl+Enter envia e Enter quebra a linha')).toBeChecked();
  await page.getByLabel('Enter envia e Shift+Enter quebra a linha').check();
  await page.getByRole('button', { name: 'Salvar preferência' }).click();
  await page.getByRole('button', { name: 'Abrir assistente', exact: true }).click();
  await expect(page.locator('.send-hint')).toContainText('Enter envia e Shift+Enter');
  await page.getByLabel('Sua mensagem').fill('Anota: Comprar pilhas');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.locator('.bubble.assistant').last()).toContainText('Comprar pilhas adicionada');
  await page.getByLabel('Sua mensagem').fill('Quais tarefas existem?');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.locator('.bubble.assistant').last()).toContainText('2 tarefa(s)');
  await page.reload();
  // Recarregar volta para a conversa, e ela guarda o que foi trocado antes.
  await expect(page.locator('.bubble.user').last()).toContainText('Quais tarefas existem?');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Todas as tarefas/ })
    .click();
  await expect(page.getByRole('button', { name: 'Editar Comprar pilhas' })).toBeVisible();
  await page.getByLabel('Buscar tarefas').fill('pares');
  await expect(page.getByRole('button', { name: 'Editar Revisar limites' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Editar Comprar pilhas' })).not.toBeVisible();
  await page.getByLabel('Limpar busca').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByLabel('Sua senha')).toBeVisible();
  expect(errors).toEqual([]);
});

test('rotas privadas não aceitam requisições anônimas', async ({ request }) => {
  expect((await request.get('/api/state')).status()).toBe(401);
  expect((await request.post('/api/actions', { data: { commands: [] } })).status()).toBe(401);
  expect((await request.get('/api/llm-providers')).status()).toBe(401);
  expect((await request.post('/api/llm-providers', { data: {} })).status()).toBe(401);
  expect((await request.post('/api/chat', { data: {} })).status()).toBe(401);
  expect((await request.get('/api/cron/cleanup')).status()).toBe(401);
});
