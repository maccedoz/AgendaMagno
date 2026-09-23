import { needsFinance } from './finance/rules';
import { loadFinance } from './finance/store';
import { panelCommandsSchema } from './domain';
import { randomUUID } from 'node:crypto';
import { databaseHint, db, loadState, saveState, lock, type Database, type Sql } from './db';
import { DomainError, execute, purge, UNSUPPORTED } from './domain';
import { interpret } from './interpreter';
import { generateReply, listProviders } from './llm';

interface Message {
  id: string;
  external_id: string;
  channel: string;
  body: string | null;
  reply: string | null;
  status: string;
  error: string | null;
  created_at: Date | string;
}
const interrupted = 'O processamento foi interrompido. Reenvie o pedido para tentar novamente.';

async function expireInterrupted(tx: Sql) {
  await tx.query(
    `UPDATE agenda_messages SET status='failed',error=$1,lease_token=NULL,lease_until=NULL,updated_at=now()
     WHERE channel='web' AND status='processing' AND lease_until<now()`,
    [interrupted],
  );
}
async function currentState(tx: Sql, now = new Date()) {
  const before = await loadState(tx);
  const result = purge(before, now);
  await saveState(tx, before, result.state);
  return result;
}
async function trimLogs(tx: Sql, now: Date) {
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  await tx.query(
    `UPDATE agenda_messages SET body=NULL,reply=NULL,error=NULL
     WHERE received_at<$1 AND status IN ('done','clarification','failed')
     AND (body IS NOT NULL OR reply IS NOT NULL OR error IS NOT NULL)`,
    [cutoff],
  );
  await tx.query('DELETE FROM agenda_limits WHERE expires_at<$1', [now.toISOString()]);
  await tx.query('DELETE FROM agenda_sessions WHERE expires_at<$1', [now.toISOString()]);
}
export async function snapshot(database?: Database) {
  const connection = database ?? (await db());
  const data = await connection.transaction(async (tx) => {
    await lock(tx);
    await expireInterrupted(tx);
    const { state } = await currentState(tx);
    await trimLogs(tx, new Date());
    const messages = (
      await tx.query(
        `SELECT id,channel,CASE WHEN channel='web' THEN body ELSE NULL END AS body,reply,status,error,created_at FROM agenda_messages
         WHERE channel IN ('web','panel') AND (body IS NOT NULL OR reply IS NOT NULL)
         ORDER BY received_at DESC,id DESC LIMIT 50`,
      )
    ).rows;
    return {
      tasks: state.tasks,
      groups: state.groups,
      history: state.history,
      settings: {
        retentionDays: state.settings.retentionDays,
        revision: state.settings.revision,
        naturalReply: state.settings.naturalReply !== false,
      },
      messages,
      storage: process.env.DATABASE_MODE === 'local' ? 'local' : 'neon',
    };
  });
  const { providers } = await listProviders(connection);
  return { ...data, llm: providers.some((p) => p.enabled && p.keySet) ? 'configured' : 'none' };
}
export async function panelAction(commands: unknown, requestId: string, database?: Database) {
  const connection = database ?? (await db());
  return connection.transaction(async (tx) => {
    await lock(tx);
    const prior = (
      await tx.query<Message>('SELECT * FROM agenda_messages WHERE external_id=$1', [
        `panel:${requestId}`,
      ])
    ).rows[0];
    if (prior) {
      if (prior.body !== null && prior.body !== JSON.stringify(commands))
        throw new DomainError('Este pedido já foi usado para outra ação.', 409);
      return { reply: prior.reply, clarification: prior.status === 'clarification' };
    }
    const { state: before } = await currentState(tx);
    const validated = panelCommandsSchema.parse(commands);
    if (validated.some(needsFinance)) before.finance = await loadFinance(tx);
    const result = execute(before, validated, 'panel');
    await saveState(tx, before, result.state);
    await tx.query(
      'INSERT INTO agenda_messages(id,external_id,channel,reply,status,body) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        `panel:${requestId}`,
        'panel',
        result.reply,
        result.clarification ? 'clarification' : 'done',
        JSON.stringify(commands),
      ],
    );
    return { reply: result.reply, clarification: result.clarification };
  });
}
function response(message: Message) {
  return { id: message.id, reply: message.reply, status: message.status, error: message.error };
}

// Segunda passagem pela IA: o executor já produziu a resposta e as alterações já foram
// gravadas. Aqui só a redação muda, e apenas se a versão reescrita preservar cada linha de
// tarefa — ver llm/reply.ts. Qualquer falha devolve a resposta original: uma alteração
// confirmada nunca pode ser perdida por causa do acabamento do texto.
async function polish(
  reply: string,
  request: string,
  enabled: boolean,
  connection: Database,
  rewrite: typeof generateReply,
) {
  if (!enabled || !reply.trim() || reply.startsWith(UNSUPPORTED)) return reply;
  try {
    return (await rewrite(reply, request, connection)) ?? reply;
  } catch {
    return reply;
  }
}
// A mensagem é aceita em duas etapas. A primeira grava o texto e reserva o pedido; a segunda
// interpreta e executa. Quem chama decide se espera a segunda ou deixa correr depois de
// responder — a rota HTTP usa `after`, para que fechar a aba não interrompa o trabalho.
// The result and mutations commit together, so repeating a request never repeats its actions.
export async function startChat(
  text: string,
  requestId: string,
  database?: Database,
  interpreter = interpret,
  rewrite = generateReply,
) {
  const connection = database ?? (await db());
  const token = randomUUID();
  const claimed = await connection.transaction(async (tx) => {
    await lock(tx);
    await expireInterrupted(tx);
    const existing = (
      await tx.query<Message>('SELECT * FROM agenda_messages WHERE external_id=$1', [
        `web:${requestId}`,
      ])
    ).rows[0];
    if (existing) {
      if (existing.body !== null && existing.body !== text)
        throw new DomainError('Este pedido já foi usado para outra mensagem.', 409);
      if (existing.status !== 'failed' || existing.body === null) return { prior: existing };
    }
    const busy = await tx.query(
      "SELECT id FROM agenda_messages WHERE channel='web' AND status='processing' LIMIT 1",
    );
    if (busy.rows.length)
      throw new DomainError(
        'O assistente está respondendo a outro pedido. Aguarde a resposta e tente novamente.',
        409,
      );
    const { state } = await currentState(tx);
    const now = new Date();
    const message: Message = {
      id: existing?.id ?? randomUUID(),
      external_id: `web:${requestId}`,
      channel: 'web',
      body: text,
      reply: null,
      error: null,
      status: 'processing',
      created_at: now,
    };
    await tx.query(
      `INSERT INTO agenda_messages(id,external_id,channel,body,status,lease_token,lease_until,created_at)
       VALUES($1,$2,'web',$3,'processing',$4,now()+interval '150 seconds',$5)
       ON CONFLICT(id) DO UPDATE SET status='processing',reply=NULL,error=NULL,lease_token=$4,lease_until=now()+interval '150 seconds',updated_at=now()`,
      [message.id, message.external_id, text, token, now.toISOString()],
    );
    return { message, state };
  });
  if (claimed.prior) return { accepted: response(claimed.prior), run: null };
  const { message, state } = claimed;
  async function finish() {
    // Depois que esta transação confirma, o pedido está feito. O que vem a seguir é redação, e
    // fica fora do try justamente para que nada ali possa devolver "falhou" para um trabalho que
    // já foi gravado.
    let committed: { id: string; status: string; reply: string; natural: boolean };
    try {
      const commands = await interpreter(
        state,
        text,
        'web',
        new Date(message.created_at),
        connection,
      );
      committed = await connection.transaction(async (tx) => {
        await lock(tx);
        const active = await tx.query(
          "SELECT id FROM agenda_messages WHERE id=$1 AND status='processing' AND lease_token=$2 AND lease_until>=now()",
          [message.id, token],
        );
        if (!active.rows.length) throw new DomainError(interrupted, 409);
        const { state: before } = await currentState(tx);
        if (before.settings.revision !== state.settings.revision)
          throw new DomainError(
            'Os dados mudaram durante a interpretação. Nenhuma ação deste pedido foi aplicada; reenvie a mensagem.',
            409,
          );
        if (commands.some(needsFinance)) before.finance = await loadFinance(tx);
        const result = execute(before, commands, 'web', new Date(message.created_at));
        await saveState(tx, before, result.state);
        const status = result.clarification ? 'clarification' : 'done';
        await tx.query(
          'UPDATE agenda_messages SET status=$2,reply=$3,error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',
          [message.id, status, result.reply],
        );
        return {
          id: message.id,
          status,
          reply: result.reply,
          natural: !commands.some(needsFinance) && result.state.settings.naturalReply !== false,
        };
      });
    } catch (error) {
      // Erro do PostgreSQL vira a mesma dica que a API dá nas outras rotas: sem isso, migração
      // não aplicada e credencial vencida chegavam à conversa como o mesmo "não foi possível".
      const safe =
        error instanceof DomainError
          ? error.message
          : (error as { code?: unknown })?.code
            ? `Não foi possível processar o pedido. Nenhuma alteração foi confirmada. ${databaseHint(error)}`
            : 'Não foi possível processar o pedido. Nenhuma alteração foi confirmada.';
      await connection.query(
        `UPDATE agenda_messages SET status='failed',error=$3,lease_token=NULL,lease_until=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_token=$2`,
        [message.id, token, safe],
      );
      return { id: message.id, status: 'failed', reply: null, error: safe };
    }
    // Fora da transação de propósito: é uma chamada de rede, e prender a linha da agenda durante
    // ela bloquearia qualquer outra escrita pelo tempo da resposta do provedor.
    const reply = await polish(committed.reply, text, committed.natural, connection, rewrite);
    if (reply !== committed.reply)
      await connection
        .query('UPDATE agenda_messages SET reply=$2,updated_at=now() WHERE id=$1', [
          committed.id,
          reply,
        ])
        // A resposta já foi entregue; o histórico guardar a versão original é uma diferença de
        // redação, não de conteúdo.
        .catch(() => {});
    return { id: committed.id, status: committed.status, reply, error: null };
  }
  return {
    // Já gravada e reservada: a resposta pode sair agora, e o resultado é consultado depois
    // pela listagem de mensagens.
    accepted: { id: message.id, status: 'processing', reply: null, error: null },
    run: finish,
  };
}
// Caminho síncrono: aceita a mensagem e espera o resultado. Usado pelos testes e por quem
// precisa da resposta na mesma chamada.
export async function chat(
  text: string,
  requestId: string,
  database?: Database,
  interpreter = interpret,
  rewrite = generateReply,
) {
  const started = await startChat(text, requestId, database, interpreter, rewrite);
  return started.run ? await started.run() : started.accepted;
}
export async function clearChat(database?: Database) {
  const connection = database ?? (await db());
  return connection.transaction(async (tx) => {
    await lock(tx);
    await expireInterrupted(tx);
    // As linhas ficam, sem texto: o external_id é o que impede um pedido repetido de executar
    // duas vezes. A listagem esconde mensagens sem texto, então a conversa some da tela.
    const cleared = await tx.query(
      `UPDATE agenda_messages SET body=NULL,reply=NULL,error=NULL,updated_at=now()
       WHERE channel='web' AND status<>'processing'
         AND (body IS NOT NULL OR reply IS NOT NULL OR error IS NOT NULL)
       RETURNING id`,
    );
    // Sem isso o assistente continuaria lembrando do grupo e das tarefas recentes.
    await tx.query("DELETE FROM agenda_conversations WHERE id='web'");
    return { cleared: cleared.rows.length };
  });
}
export async function cleanup(database?: Database, now = new Date()) {
  const connection = database ?? (await db());
  return connection.transaction(async (tx) => {
    await lock(tx);
    await expireInterrupted(tx);
    const result = await currentState(tx, now);
    await trimLogs(tx, now);
    return { removed: result.removed.length };
  });
}
