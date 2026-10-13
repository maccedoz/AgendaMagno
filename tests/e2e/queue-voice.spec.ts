import { test, expect, type Page } from '@playwright/test';
import type { Data, Message } from '../../src/frontend/dashboard/types';
async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Sua mensagem')).toBeVisible();
}
async function mockChat(page: Page) {
  const data: Data = {
    tasks: [],
    groups: [],
    history: [],
    settings: { retentionDays: 30, revision: 0, naturalReply: false },
    messages: [],
    llm: 'none',
    storage: 'local',
  };
  await page.route('**/api/auth', (r) =>
    r.fulfill({
      json: {
        authenticated: true,
        trusted: false,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  const calls: { text: string; requestId: string }[] = [];
  let fail = false;
  await page.route('**/api/state', (r) => r.fulfill({ json: data }));
  await page.route('**/api/chat', async (r) => {
    const body = r.request().postDataJSON();
    calls.push(body);
    if (fail) {
      fail = false;
      await r.fulfill({ status: 503, json: { error: 'Falha simulada' } });
      return;
    }
    expect(data.messages.filter((m) => m.status === 'processing')).toHaveLength(0);
    const message: Message = {
      id: body.requestId,
      body: body.text,
      channel: 'web',
      status: 'processing',
      reply: null,
      error: null,
      created_at: new Date().toISOString(),
    };
    data.messages.unshift(message);
    await r.fulfill({ json: message });
  });
  return {
    calls,
    data,
    failNext: () => {
      fail = true;
    },
    finish: (status = 'done') => {
      const current = data.messages.find((m) => m.status === 'processing')!;
      current.status = status;
      current.reply =
        status === 'clarification' ? 'Qual opção deseja?' : `Concluído: ${current.body}`;
      data.settings.revision++;
    },
  };
}
async function send(page: Page, text: string) {
  await page.getByLabel('Sua mensagem').fill(text);
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
}

test('fila executa A, B e C em ordem e mantém o campo editável', async ({ page }) => {
  const chat = await mockChat(page);
  await login(page);
  await send(page, 'A');
  await expect.poll(() => chat.calls.length).toBe(1);
  await send(page, 'B');
  await send(page, 'C');
  await expect(page.getByRole('status').filter({ hasText: 'Em espera · posição 2' })).toBeVisible();
  await expect(page.getByLabel('Sua mensagem')).toBeEnabled();
  expect(chat.calls.map((c) => c.text)).toEqual(['A']);
  chat.finish();
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['A', 'B']);
  chat.finish();
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['A', 'B', 'C']);
  chat.finish();
  await expect(page.getByText('Concluído: C', { exact: true })).toBeVisible();
  expect(new Set(chat.calls.map((c) => c.requestId)).size).toBe(3);
});
test('fila remove pendentes, pausa no erro e reutiliza o ID ao tentar novamente', async ({
  page,
}) => {
  const chat = await mockChat(page);
  await login(page);
  chat.failNext();
  await send(page, 'A');
  await expect(page.getByRole('button', { name: 'Tentar novamente', exact: true })).toBeVisible();
  await send(page, 'B');
  await send(page, 'C');
  await page.getByRole('button', { name: 'Remover mensagem em espera' }).first().click();
  expect(chat.calls.length).toBe(1);
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect.poll(() => chat.calls.length).toBe(2);
  expect(chat.calls[0].requestId).toBe(chat.calls[1].requestId);
  chat.finish();
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['A', 'A', 'C']);
  chat.finish();
  await expect(page.getByText('Concluído: C', { exact: true })).toBeVisible();
});
test('esclarecimento é respondido antes da mensagem em espera', async ({ page }) => {
  const chat = await mockChat(page);
  await login(page);
  await send(page, 'A');
  await expect.poll(() => chat.calls.length).toBe(1);
  await send(page, 'B');
  chat.finish('clarification');
  await expect(page.getByText(/Fila pausada: responda/)).toBeVisible();
  expect(chat.calls.length).toBe(1);
  await send(page, 'Resposta');
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['A', 'Resposta']);
  chat.finish();
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['A', 'Resposta', 'B']);
  chat.finish();
  await expect(page.getByText('Concluído: B', { exact: true })).toBeVisible();
});
test('sair do chat avisa sobre pendentes e cancelar conserva a fila', async ({ page }) => {
  const chat = await mockChat(page);
  await login(page);
  await send(page, 'A');
  await send(page, 'B');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Financeiro', exact: true })
    .click();
  await expect(page.getByLabel('Sua mensagem')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Em espera · posição 1' })).toBeVisible();
  chat.finish();
  await expect.poll(() => chat.calls.length).toBe(2);
  chat.finish();
});

test('ditado preserva rascunho, não duplica resultados, cancela e trata erro e limite', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    class Speech {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        w.testSpeech = this;
      }
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    w.SpeechRecognition = Speech;
  });
  const chat = await mockChat(page);
  await login(page);
  const emit = async (text: string) =>
    page.evaluate((value) => {
      const speech = (window as unknown as { testSpeech: { onresult: (e: unknown) => void } })
        .testSpeech;
      speech.onresult({ results: [{ isFinal: true, 0: { transcript: value } }] });
    }, text);
  await page.getByLabel('Sua mensagem').fill('Anota:');
  await page.getByRole('button', { name: 'Ditar mensagem' }).click();
  await emit('comprar pilhas');
  await emit('comprar pilhas');
  await expect(page.getByLabel('Sua mensagem')).toHaveValue('Anota: comprar pilhas');
  expect(chat.calls.length).toBe(0);
  await page.getByRole('button', { name: 'Cancelar ditado' }).click();
  await expect(page.getByLabel('Sua mensagem')).toHaveValue('Anota:');
  await page.getByRole('button', { name: 'Ditar mensagem' }).click();
  await emit('comprar pilhas');
  await page.getByRole('button', { name: 'Parar ditado' }).click();
  await expect(page.getByLabel('Sua mensagem')).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect.poll(() => chat.calls.length).toBe(1);
  chat.finish();
  await page.getByRole('button', { name: 'Ditar mensagem' }).click();
  await page.evaluate(() => {
    (window as unknown as { testSpeech: { onerror: (e: unknown) => void } }).testSpeech.onerror({
      error: 'not-allowed',
    });
  });
  await expect(page.getByText(/Permissão de microfone negada/)).toBeVisible();
  await page.getByLabel('Sua mensagem').fill('Rascunho');
  await page.getByRole('button', { name: 'Ditar mensagem' }).click();
  await emit('a'.repeat(6001));
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  await expect(page.getByLabel('Sua mensagem')).toHaveValue('Rascunho ' + 'a'.repeat(6001));
});
test('sem reconhecimento de voz a digitação permanece disponível', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined });
  });
  await mockChat(page);
  await login(page);
  await expect(page.getByText(/Ditado indisponível neste navegador/)).toBeVisible();
  await expect(page.getByLabel('Sua mensagem')).toBeEnabled();
});

test('Ctrl+Enter envia e Enter quebra a linha; o outro modo envia com Enter', async ({ page }) => {
  const chat = await mockChat(page);
  await login(page);
  const box = page.getByLabel('Sua mensagem');
  await box.fill('Anota: pão');
  await box.press('Enter');
  await box.pressSequentially('leite');
  await expect(box).toHaveValue('Anota: pão\nleite');
  expect(chat.calls).toHaveLength(0);
  await box.press('Control+Enter');
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['Anota: pão\nleite']);
  await expect(box).toHaveValue('');
  chat.finish();
  // A escolha feita nas configurações fica guardada no aparelho.
  await page.evaluate(() => localStorage.setItem('agenda:send-key', 'enter'));
  await page.reload();
  await expect(page.locator('.send-hint')).toContainText('Enter envia e Shift+Enter');
  await box.fill('A');
  await box.press('Shift+Enter');
  await box.pressSequentially('B');
  await expect(box).toHaveValue('A\nB');
  await page.screenshot({ path: 'test-results/chat-multiline.png' });
  await box.press('Enter');
  await expect.poll(() => chat.calls.map((c) => c.text)).toEqual(['Anota: pão\nleite', 'A\nB']);
});
