import { financeSnapshot } from '@/backend/finance/store';
import { summarySnapshot } from '@/backend/summary-store';
import { goalsSnapshot } from '@/backend/goals/store';
import {
  deleteFinancePlanItem,
  financePlan,
  saveFinancePlanItem,
} from '@/backend/finance/plan-store';
import {
  addNoteFile,
  deleteNote,
  deleteNoteFile,
  listNotes,
  readNote,
  readNoteFile,
  saveNote,
} from '@/backend/notes/store';
import { after } from 'next/server';
import { z } from 'zod';
import { cookie, cronAuth, sameOrigin } from '@/backend/auth';
import {
  session,
  login,
  accessInfo,
  updateAccess,
  revokeSession,
  reauthenticate,
} from '@/backend/access';
import { exportBackup, importBackup } from '@/backend/backup';
import { databaseHint } from '@/backend/db';
import { DomainError } from '@/backend/domain';
import { cleanup, clearChat, panelAction, snapshot, startChat } from '@/backend/service';
import { deleteProvider, listProviders, resetProvider, saveProvider } from '@/backend/llm';
import { pushInfo, sendTest, subscribe, sweepReminders, unsubscribe } from '@/backend/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
async function read(request: Request, maximum = 65536) {
  if (Number(request.headers.get('content-length') ?? 0) > maximum)
    throw new DomainError('Requisição muito grande.', 413);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new DomainError('Requisição muito grande.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function handler(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path.join('/');
    const method = request.method;
    if (path === 'health' && method === 'GET') return reply({ ok: true });
    if (path === 'auth' && method === 'GET') {
      const current = await session(request);
      return reply({
        authenticated: Boolean(current),
        trusted: current?.trusted ?? false,
        expiresAt: current?.expires_at ?? null,
      });
    }
    if (path === 'cron/cleanup' && method === 'GET') {
      cronAuth(request);
      return reply(await cleanup());
    }
    // Chamado por um agendador externo a cada poucos minutos (o cron da Vercel no Hobby é
    // diário), com o mesmo Authorization: Bearer CRON_SECRET da limpeza.
    if (path === 'cron/reminders' && method === 'GET') {
      cronAuth(request);
      return reply(await sweepReminders());
    }
    if (path === 'login' && method === 'POST') {
      sameOrigin(request);
      const result = await login(request, JSON.parse(await read(request)));
      return reply(
        { ok: !result.needsCode, needsCode: result.needsCode, expiresAt: result.expiresAt },
        200,
        result.cookie ? { 'Set-Cookie': result.cookie } : {},
      );
    }
    const current = await session(request);
    if (!current) throw new DomainError('Entre para continuar.', 401);
    if (method === 'GET' && path === 'security') return reply(await accessInfo(current));
    if (method === 'GET' && path === 'backup') return reply(await exportBackup());
    if (method === 'GET' && path === 'finance')
      return reply(await financeSnapshot(Object.fromEntries(new URL(request.url).searchParams)));
    if (method === 'GET' && path === 'finance/plan')
      return reply(await financePlan(Object.fromEntries(new URL(request.url).searchParams)));
    if (method === 'GET' && path === 'summary')
      return reply(await summarySnapshot(Object.fromEntries(new URL(request.url).searchParams)));
    if (method === 'GET' && path === 'goals') return reply(await goalsSnapshot());
    if (method === 'GET' && path === 'notes')
      return reply(await listNotes(Object.fromEntries(new URL(request.url).searchParams)));
    if (method === 'GET' && path === 'notes/note')
      return reply(await readNote(Object.fromEntries(new URL(request.url).searchParams)));
    if (method === 'GET' && path === 'notes/file')
      return reply(await readNoteFile(Object.fromEntries(new URL(request.url).searchParams)));
    if (method === 'GET' && path === 'state') return reply(await snapshot());
    if (method === 'GET' && path === 'llm-providers') return reply(await listProviders());
    if (method === 'GET' && path === 'push') return reply(await pushInfo());
    if (method !== 'POST') throw new DomainError('Rota não encontrada.', 404);
    sameOrigin(request);
    if (path === 'logout') {
      await revokeSession(current.id);
      return reply({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    }
    // Anexo de anotação chega em base64 no corpo JSON: 3 MB de arquivo dão pouco mais de 4 MB
    // de texto, dentro do teto de 4,5 MB que a Vercel aplica ao corpo da requisição. O restante
    // das rotas continua com o limite pequeno de sempre.
    const limit =
      path === 'notes/file'
        ? 4 * 1024 * 1024 + 256 * 1024
        : path === 'backup/import'
          ? 2 * 1024 * 1024
          : 65536;
    const body = JSON.parse(await read(request, limit));
    if (path === 'security') return reply(await updateAccess(current, body));
    if (path === 'backup/import') {
      const value = z
        .object({ backup: z.unknown(), expectedRevision: z.number().int().nonnegative() })
        .parse(body);
      await reauthenticate(current, body);
      return reply(await importBackup(value.backup, value.expectedRevision));
    }
    if (path === 'actions') {
      const value = z.object({ commands: z.unknown(), requestId: z.string().uuid() }).parse(body);
      return reply(await panelAction(value.commands, value.requestId));
    }
    if (path === 'chat') {
      const value = z
        .object({ text: z.string().trim().min(1).max(6000), requestId: z.string().uuid() })
        .parse(body);
      const started = await startChat(value.text, value.requestId);
      // A resposta sai assim que a mensagem está gravada e reservada. A interpretação e a
      // execução continuam depois dela, para que fechar a aba ou perder a conexão não
      // interrompa o pedido — quem ficar na tela vê o resultado pela listagem de mensagens.
      if (started.run) after(started.run);
      return reply(started.accepted);
    }
    if (path === 'finance/plan') return reply(await saveFinancePlanItem(body));
    if (path === 'finance/plan/delete') return reply(await deleteFinancePlanItem(body));
    if (path === 'notes') return reply(await saveNote(body));
    if (path === 'notes/delete') return reply(await deleteNote(body));
    if (path === 'notes/file') return reply(await addNoteFile(body));
    if (path === 'notes/file/delete') return reply(await deleteNoteFile(body));
    if (path === 'chat/clear') return reply(await clearChat());
    if (path === 'push/subscribe') return reply(await subscribe(body, current.label));
    if (path === 'push/unsubscribe') return reply(await unsubscribe(body));
    if (path === 'push/test') return reply(await sendTest(body));
    if (path === 'llm-providers') return reply(await saveProvider(body));
    if (path === 'llm-providers/delete' || path === 'llm-providers/reset') {
      const { id } = z.object({ id: z.string().uuid() }).parse(body);
      return reply(path.endsWith('/delete') ? await deleteProvider(id) : await resetProvider(id));
    }
    throw new DomainError('Rota não encontrada.', 404);
  } catch (error) {
    if (error instanceof DomainError) return reply({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return reply(
        {
          error: 'Dados inválidos. Confira os campos.',
          details: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
        400,
      );
    if (error instanceof SyntaxError) return reply({ error: 'JSON inválido.' }, 400);
    console.error('AgendaMagno API failure:', error instanceof Error ? error.name : 'UnknownError');
    return reply({ error: `Não foi possível concluir a operação. ${databaseHint(error)}` }, 500);
  }
}
export const GET = handler;
export const POST = handler;
