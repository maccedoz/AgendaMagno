import type { z } from 'zod';
import { type Database } from '../db';
import { commandsSchema, DomainError, localDate, MAX_AI_COMMANDS, type Command } from '../domain';
import { decryptKey, encryptionKey } from './crypto';
import { GEMINI_URL, type ProviderRow } from './providers';
import {
  estimateTokens,
  markError,
  pauseReason,
  reserve,
  retryDelay,
  settle,
  tokenUsage,
} from './usage';
import { secureFetch, validateApiUrl } from './ssrf';

const MAX_ATTEMPTS = 4;
const MAX_OUTPUT_TOKENS = 2048;
const REPLY_OUTPUT_TOKENS = 700;

// O laço de failover é o mesmo para as duas chamadas do ciclo: a que interpreta o pedido e a
// que reescreve a resposta pronta. O que muda é o que fazer com o texto devolvido e o que fazer
// quando nenhum modelo responde — daí `parse` e `strict`.
export type ParseResult<T> = { ok: true; value: T } | { ok: false; failure: string };
interface ModelTask<T> {
  system: string;
  text: string;
  json: boolean;
  maxOutputTokens: number;
  // `failure` descreve o problema para o painel, sem repetir o texto do modelo.
  parse: (output: string) => ParseResult<T>;
  // true: falha vira DomainError e interrompe o pedido. false: falha vira null e quem chamou
  // segue com o que já tinha — usado na reescrita, que é um acabamento, não o resultado.
  strict: boolean;
}

// Names the field and the kind of problem, so a rejected answer can be diagnosed from the panel.
// Uses only the issue's structure, never its message: zod quotes the offending value, and that
// value comes from the model, which may be repeating the person's own text.
function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const [index, ...rest] = issue.path;
      const where = typeof index === 'number' ? `ação ${index + 1}` : 'lista de ações';
      const field = rest.length ? `, campo ${rest.join('.')}` : '';
      const keys = (issue as { keys?: string[] }).keys;
      if (issue.code === 'unrecognized_keys')
        return `${where}: campo não previsto ${keys?.join(', ')}`;
      if (issue.code === 'invalid_value') return `${where}${field}: valor fora dos aceitos`;
      if (issue.code === 'invalid_type') return `${where}${field}: faltando ou de tipo errado`;
      if (issue.code === 'too_big' || issue.code === 'too_small')
        return `${where}${field}: fora do tamanho permitido`;
      return `${where}${field}: ${issue.code}`;
    })
    .join('; ');
}

export interface LlmRequestOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: Date;
}
async function runModel<T>(
  task: ModelTask<T>,
  database: Database,
  options: LlmRequestOptions = {},
): Promise<T | null> {
  const { system, text } = task;
  const now = options.now ?? new Date();
  const started = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - started);
  const candidates = (
    await database.query<{
      id: string;
      name: string;
      kind: string;
    }>(`SELECT id,config->>'name' AS name,config->>'kind' AS kind FROM agenda_llm_providers WHERE (config->>'enabled')::boolean
    ORDER BY (config->>'priority')::integer,created_at,id`)
  ).rows;
  if (!candidates.length) return null;
  // Modelos de raciocínio costumam recusar `response_format: json_object` — o texto sai do
  // passo de raciocínio e a API não garante o formato. Recusar o pedido por isso deixaria a
  // pessoa sem saída, então cada provedor compatível ganha uma segunda tentativa sem esse
  // campo; o prompt já exige JSON e o leitor já aceita texto em volta do objeto. A segunda
  // tentativa só entra em cena se a primeira for recusada com HTTP 400.
  const plan = candidates.flatMap((candidate) =>
    task.json && candidate.kind === 'compatible'
      ? [
          { ...candidate, json: true, onlyAfterJsonRejection: false },
          { ...candidate, json: false, onlyAfterJsonRejection: true },
        ]
      : [{ ...candidate, json: task.json, onlyAfterJsonRejection: false }],
  );
  const jsonRejected = new Set<string>();
  // Check encryption once, so an invalid server secret isn't mistaken for quota exhaustion.
  encryptionKey();
  const estimate = estimateTokens(system + text) + task.maxOutputTokens;
  const deadline = Date.now() + 85000;
  let attempts = 0;
  const failures: string[] = [];
  let stoppedEarly = false;
  for (const candidate of plan) {
    if (candidate.onlyAfterJsonRejection && !jsonRejected.has(candidate.id)) continue;
    if (attempts >= MAX_ATTEMPTS || Date.now() >= deadline) {
      stoppedEarly = true;
      break;
    }
    const day = localDate(clock());
    const reservation = await reserve(database, candidate.id, day, estimate, clock());
    if (!reservation.provider) {
      failures.push(`${candidate.name}: ${reservation.reason}`);
      continue;
    }
    const provider = reservation.provider;
    attempts++;
    let response: Response;
    try {
      const apiKey = decryptKey(provider.encrypted_key, provider.id);
      const { config } = provider;
      const url =
        config.kind === 'gemini'
          ? `${GEMINI_URL}/${encodeURIComponent(config.model.replace(/^models\//, ''))}:generateContent`
          : config.apiUrl;
      validateApiUrl(url);
      const body =
        config.kind === 'gemini'
          ? {
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text }] }],
              generationConfig: {
                temperature: 0,
                ...(candidate.json ? { responseMimeType: 'application/json' } : {}),
                maxOutputTokens: task.maxOutputTokens,
                // O raciocínio do 2.5 Flash consome o mesmo orçamento de saída e o tempo da
                // requisição: com ele ligado, o pedido estourava a espera ou voltava sem texto,
                // porque os tokens todos viravam pensamento. Interpretar comandos com um prompt
                // já estruturado não depende dele. Só estes modelos aceitam desligar.
                ...(/2\.5-flash/.test(config.model)
                  ? { thinkingConfig: { thinkingBudget: 0 } }
                  : {}),
              },
            }
          : {
              model: config.model,
              temperature: 0,
              max_tokens: task.maxOutputTokens,
              ...(candidate.json ? { response_format: { type: 'json_object' } } : {}),
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: text },
              ],
            };
      response = await (options.fetch ?? secureFetch)(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(config.kind === 'gemini'
            ? { 'x-goog-api-key': apiKey }
            : { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(45000, deadline - Date.now()))),
      });
    } catch (error) {
      await settle(database, provider.id, day, estimate, {
        tokens: 0,
        source: error instanceof DomainError ? 'rejected' : 'unconfirmed',
      });
      if (error instanceof DomainError) throw error;
      const timedOut =
        error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
      const message = timedOut
        ? 'A API demorou além do tempo de espera. Não foi possível confirmar o consumo de tokens.'
        : 'Falha de conexão com a API. Não foi possível confirmar o consumo de tokens.';
      const failedAt = clock();
      const until = await markError(database, provider.id, message, 60000, failedAt);
      failures.push(
        `${candidate.name}: ${pauseReason({ ...provider, last_error: message, cooldown_until: until }, failedAt)}`,
      );
      continue;
    }
    if (!response.ok) {
      await settle(database, provider.id, day, estimate, { tokens: 0, source: 'rejected' });
      const status = response.status;
      const message =
        status === 429
          ? 'A API limitou as chamadas (HTTP 429). Pode ser um limite por minuto ou por dia; isso não confirma que seu saldo de tokens acabou.'
          : status === 402
            ? 'Créditos esgotados na API.'
            : status === 401 || status === 403
              ? 'Chave inválida ou sem permissão. Confira a credencial e o modelo.'
              : status >= 500 || status === 408
                ? 'API temporariamente indisponível.'
                : // Endereço de site e de painel redireciona; endpoint de API responde direto.
                  // A agenda não segue redirecionamento, para o destino não escapar da
                  // verificação de endereço público feita antes da conexão.
                  status >= 300 && status < 400
                  ? 'O endereço respondeu com um redirecionamento, que não é seguido por segurança. Isso costuma ser o endereço do site ou do painel do serviço no lugar do endpoint da API. No Groq, por exemplo, o endpoint é https://api.groq.com/openai/v1/chat/completions.'
                  : status === 404
                    ? 'A API não reconheceu o endereço. Informe o endpoint completo de Chat Completions, com o caminho inteiro (…/v1/chat/completions), e não só o endereço base.'
                    : status === 400
                      ? 'A API recusou o pedido. Confira o identificador do modelo e se ele aceita resposta em JSON.'
                      : 'A API recusou a configuração. Confira modelo e URL.';
      const fallback =
        status === 401 || status === 403 || status === 402
          ? 86400000
          : status === 429
            ? 60000
            : 60000;
      const failedAt = clock();
      // O corpo é lido uma vez só: dele saem o código estruturado do erro e, no Gemini, o
      // RetryInfo. Nunca o texto do provedor, que pode repetir a mensagem da pessoa.
      const body = await response.json().catch(() => null);
      // Só identificadores curtos e sem espaços atravessam — "unknown_url", "model_not_found",
      // "INVALID_ARGUMENT", e o nome do campo recusado em `param`. Uma frase não passa neste
      // filtro, e é por isso que o texto do provedor nunca chega à tela.
      const short = (value: unknown) =>
        typeof value === 'string' && /^[A-Za-z0-9_.\[\]-]{1,60}$/.test(value) ? value : null;
      const code =
        short(body?.error?.code) ?? short(body?.error?.type) ?? short(body?.error?.status);
      const field = short(body?.error?.param);
      // O tipo "Gemini" não tem campo de URL na tela: ele sempre fala com a API do Google.
      // Escolhê-lo para um modelo de outro serviço leva a agenda a pedir esse modelo ao
      // Google, que recusa sem dizer o motivo real. A recusa passa a apontar a escolha errada.
      const wrongKind =
        provider.config.kind === 'gemini' && (status === 400 || status === 404)
          ? ' Este tipo fala apenas com a API do Google. Se o modelo é de outro serviço, edite a IA, escolha “Compatível com Chat Completions” e informe a URL do endpoint desse serviço.'
          : '';
      // Página web responde HTML; API de verdade responde JSON. Dizer isso evita a caça ao
      // erro quando o endereço aponta para a documentação ou para a página de login.
      const notAnApi =
        status < 300 || status >= 400
          ? /html/i.test(response.headers.get('content-type') ?? '')
            ? ' A resposta veio em HTML, não em JSON: esse endereço é uma página web, não o endpoint de uma API.'
            : ''
          : '';
      const detail = `${message}${code ? ` A API respondeu com o código ${code}.` : ''}${
        field ? ` Campo recusado: ${field}.` : ''
      }${notAnApi}${wrongKind}`;
      // Recusa de formato: a mesma API ganha uma tentativa sem `response_format`, e por isso
      // esta primeira não pausa o provedor nem entra na lista de falhas — ela ainda pode dar
      // certo daqui a um instante.
      if (status === 400 && candidate.json && candidate.kind === 'compatible') {
        jsonRejected.add(candidate.id);
        continue;
      }
      let retryAfter = response.headers.get('retry-after');
      // Gemini can return RetryInfo in the JSON body instead of an HTTP header.
      // Read only the structured duration; never expose the upstream error text.
      if (!retryAfter && status === 429) {
        const details = body?.error?.details;
        const retry = Array.isArray(details)
          ? details.find(
              (d: { '@type'?: string }) =>
                d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo',
            )
          : null;
        if (typeof retry?.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/.test(retry.retryDelay))
          retryAfter = retry.retryDelay.slice(0, -1);
      }
      const until = await markError(
        database,
        provider.id,
        detail,
        retryDelay(retryAfter, failedAt, fallback),
        failedAt,
      );
      failures.push(
        `${candidate.name}: ${pauseReason({ ...provider, last_error: detail, cooldown_until: until }, failedAt)}`,
      );
      continue;
    }
    let result: Record<string, any> | null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    // Accounting errors must propagate as database failures, never as invalid model
    // output, and must not trigger a second charge of the same request.
    await settle(
      database,
      provider.id,
      day,
      estimate,
      tokenUsage(result, provider.config.kind, system + text),
    );
    const output =
      provider.config.kind === 'gemini'
        ? result?.candidates?.[0]?.content?.parts
            ?.filter((part: { thought?: boolean }) => !part.thought)
            .map((part: { text?: string }) => part.text ?? '')
            .join('')
        : result?.choices?.[0]?.message?.content;
    // Says which step failed, so the panel can point at the real cause instead of a generic
    // "formato inválido". Never carries the model's own text: it can echo personal data.
    const outcome: ParseResult<T> =
      typeof output !== 'string' || !output.trim()
        ? {
            ok: false,
            failure: task.json
              ? 'A IA respondeu sem texto. Confira se o modelo existe e aceita responder JSON.'
              : 'A IA respondeu sem texto. Confira se o modelo existe e está disponível.',
          }
        : task.parse(output);
    if (!outcome.ok) {
      await markError(database, provider.id, outcome.failure, 60000, clock());
      // Trying a different model here could change the interpretation of a destructive
      // request. Nothing is executed unless a single response validates completely.
      if (task.strict)
        throw new DomainError(`${outcome.failure} Nenhuma alteração foi feita.`, 422);
      return null;
    }
    await database.query(
      'UPDATE agenda_llm_providers SET last_error=NULL,cooldown_until=NULL WHERE id=$1',
      [provider.id],
    );
    return outcome.value;
  }
  // A reescrita é acabamento: sem modelo disponível, quem chamou segue com a resposta que já
  // tem. Só a interpretação pode transformar a indisponibilidade em erro do pedido.
  if (!task.strict) return null;
  throw new DomainError(
    `Nenhuma alteração foi feita.\n${failures.join('\n')}${stoppedEarly ? '\nO limite de tentativas ou de tempo desta mensagem foi alcançado; nem todos os modelos foram consultados.' : ''}`,
    503,
  );
}

function parseCommands(output: string): ParseResult<Command[]> {
  // Models often wrap the object in ```json fences or add a sentence around it. Take the
  // outermost object; the schema below still decides whether its content is acceptable.
  const object = output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  let data: unknown;
  try {
    data = JSON.parse(object);
  } catch {
    return {
      ok: false,
      failure: 'A IA respondeu em texto, não em JSON. Esse modelo pode não suportar JSON.',
    };
  }
  const commands = (data as { commands?: unknown })?.commands;
  if (!Array.isArray(commands))
    return { ok: false, failure: 'A IA respondeu em JSON, mas sem a lista de ações esperada.' };
  if (commands.length === 0)
    return {
      ok: false,
      failure:
        'A IA devolveu uma lista vazia (0 ações). Reenvie o pedido indicando o que deseja fazer.',
    };
  if (commands.length > MAX_AI_COMMANDS)
    return {
      ok: false,
      failure: `A IA devolveu ${commands.length} ações; o limite é ${MAX_AI_COMMANDS} por mensagem. Divida o pedido em partes menores.`,
    };
  const checked = commandsSchema.safeParse(commands);
  if (!checked.success)
    return {
      ok: false,
      failure: `A IA montou os comandos fora do formato: ${describe(checked.error)}.`,
    };
  return { ok: true, value: checked.data };
}
export function generateCommands(
  system: string,
  text: string,
  database: Database,
  options: LlmRequestOptions = {},
): Promise<Command[] | null> {
  return runModel(
    {
      system,
      text,
      json: true,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      parse: parseCommands,
      strict: true,
    },
    database,
    options,
  );
}
export function generateText(
  system: string,
  text: string,
  parse: (output: string) => ParseResult<string>,
  database: Database,
  options: LlmRequestOptions = {},
): Promise<string | null> {
  return runModel(
    { system, text, json: true, maxOutputTokens: REPLY_OUTPUT_TOKENS, parse, strict: false },
    database,
    options,
  );
}
