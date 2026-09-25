'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, MessageCircle, Send, Trash2, Mic, TriangleAlert } from 'lucide-react';
import { useChatQueue } from './useChatQueue';
import { useDictation } from './useDictation';
import { AssistantTurn, TypingBubble } from './AssistantReply';
import { api } from './api';
import type { Data, Message } from './types';

const EXAMPLES = [
  'Anota: comprar pilhas',
  'Quais tarefas eu tenho pro dia 24?',
  'Adicione revisar o artigo em Estudos',
  'Finalizei #1',
  'Como foi minha semana?',
];

const clock = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Bahia',
  hour: '2-digit',
  minute: '2-digit',
});
const time = (value: string) => clock.format(new Date(value));
// O servidor diz em que etapa o pedido está; o tempo decorrido só troca a frase para quem
// está esperando saber que nada travou.
function thinking(message: Message, now: number) {
  if (message.stage === 'writing') return 'Escrevendo a resposta';
  const elapsed = now - new Date(message.created_at).getTime();
  if (elapsed > 20000) return 'Ainda trabalhando nisso — a IA está demorando mais que o normal';
  if (elapsed > 6000) return 'Consultando a agenda e preparando as alterações';
  return 'Entendendo o pedido';
}

// Tela inicial do painel, não uma janela sobre ele: a conversa é por onde a maior parte dos
// pedidos entra, e abrir a agenda já dentro dela poupa um clique em toda visita.
export function Assistant({
  data,
  refresh,
  offline = false,
}: {
  data: Data | null;
  refresh: () => Promise<void>;
  offline?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  // Só rola sozinho quem está no fim da conversa: quem subiu para reler não é puxado de volta.
  const pinned = useRef(true);
  // Respostas que chegaram com esta tela aberta são escritas aos poucos; as que já estavam na
  // lista aparecem inteiras.
  const live = useRef(new Set<string>());
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const queue = useChatQueue(data, refresh, offline);
  const voice = useDictation(text, setText);
  const messages = [...(data?.messages.filter((m) => m.channel === 'web') ?? [])].reverse();
  const processing = queue.serverBusy || queue.items.some((i) => i.status === 'running');
  for (const m of messages)
    if (
      m.status === 'processing' ||
      m.stage === 'writing' ||
      queue.items.some((i) => i.serverId === m.id)
    )
      live.current.add(m.id);
  const latest = messages.at(-1);
  const scroll = useCallback(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: 'end' });
  }, []);
  const reveal = useCallback(
    (id: string) => setRevealed((all) => (all.has(id) ? all : new Set(all).add(id))),
    [],
  );
  const enqueue = useRef(queue.enqueue);
  enqueue.current = queue.enqueue;
  // Tocar numa opção da pergunta equivale a responder com o número dela.
  const pick = useCallback((answer: string) => enqueue.current(answer), []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    pinned.current = true;
  }, [messages.length, queue.items.length]);
  useEffect(scroll, [processing, latest?.status, latest?.stage, scroll]);
  function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || text.length > 6000 || voice.listening || busy) return;
    queue.enqueue(text);
    setText('');
    pinned.current = true;
  }
  async function clear() {
    setBusy(true);
    setError('');
    try {
      if (processing) throw new Error('Espere o pedido em execução terminar antes de apagar.');
      await api('chat/clear', {});
      queue.reset();
      setConfirming(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-view" aria-label="Assistente da agenda">
      <div className="chat-note">
        <MessageCircle size={16} />
        {data?.llm === 'none'
          ? 'Sem IA cadastrada, entendo só frases em formato exato, como “Anota: comprar pilhas”. Cadastre uma API em Modelos de IA para escrever do seu jeito.'
          : `Toda mensagem é interpretada pela IA, na ordem de prioridade que você configurou, e conta nos limites diários.${
              data?.settings.naturalReply
                ? ' A resposta passa por uma segunda chamada, que reescreve o texto sem mudar os dados.'
                : ''
            }`}
      </div>
      <div
        className="chat-messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!messages.length && !queue.items.length && (
          <div className="chat-welcome">
            <span className="empty-icon">
              <MessageCircle size={30} />
            </span>
            <h3>O que você quer organizar?</h3>
            <p>Escreva uma tarefa ou experimente um exemplo.</p>
            <div className="chat-examples">
              {EXAMPLES.map((example) => (
                <button key={example} onClick={() => setText(example)}>
                  {example}
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => {
          const writing = m.status === 'processing' || m.stage === 'writing';
          const answerable =
            m === latest && m.status === 'clarification' && queue.pause === 'clarification';
          return (
            <div className="chat-pair" key={m.id}>
              {m.body && (
                <div className="bubble user">
                  {m.body}
                  <time dateTime={m.created_at}>{time(m.created_at)}</time>
                </div>
              )}
              {writing ? (
                <TypingBubble label={thinking(m, Date.now())} />
              ) : m.reply ? (
                <AssistantTurn
                  text={m.reply}
                  animate={live.current.has(m.id) && !revealed.has(m.id)}
                  onPick={answerable ? pick : undefined}
                  onProgress={scroll}
                  onDone={() => reveal(m.id)}
                />
              ) : (
                <div className="bubble assistant failed" role="alert">
                  <TriangleAlert size={15} />
                  <span>{m.error ?? 'O pedido não foi concluído.'}</span>
                </div>
              )}
            </div>
          );
        })}
        {queue.items
          .filter((i) => i.status !== 'done')
          .filter((i) => i.status !== 'running' || !messages.some((m) => m.id === i.serverId))
          .map((item) => (
            <div className="chat-pair queue-item" key={item.id}>
              {!messages.some((m) => m.id === item.serverId) && (
                <div className={`bubble user${item.status === 'waiting' ? ' waiting' : ''}`}>
                  {item.text}
                </div>
              )}
              {item.status === 'running' ? (
                <TypingBubble label="Enviando" />
              ) : (
                <div className="queue-status" role="status">
                  {item.status === 'waiting'
                    ? `Em espera · posição ${queue.items.filter((i) => i.status === 'waiting').findIndex((i) => i.id === item.id) + 1}`
                    : `Erro: ${item.error ?? 'Pedido interrompido'}`}
                  {item.status === 'waiting' && (
                    <button className="text-button" onClick={() => queue.remove(item.id)}>
                      Remover mensagem em espera
                    </button>
                  )}
                  {item.status === 'error' && (
                    <>
                      <button className="text-button" onClick={() => queue.retry(item.id)}>
                        Tentar novamente
                      </button>
                      <button className="text-button" onClick={() => queue.discard(item.id)}>
                        Descartar e continuar
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        <div ref={end} />
      </div>
      {error && (
        <p className="form-error chat-error" role="alert">
          {error}
        </p>
      )}
      {queue.pause === 'clarification' && (
        <p className="chat-note" role="status">
          Fila pausada: responda à pergunta do assistente. Sua resposta será executada antes das
          mensagens em espera.
        </p>
      )}
      {queue.pause === 'error' && (
        <p className="chat-note">
          Fila pausada. Tente novamente ou descarte o pedido com erro.
          {!queue.items.some((i) => i.status === 'error') && (
            <button className="text-button" onClick={queue.resume}>
              Continuar fila após revisar o erro
            </button>
          )}
        </p>
      )}
      {offline && (
        <p className="chat-note">
          Sem conexão. As mensagens aguardam nesta tela até você se conectar.
        </p>
      )}
      <div className="dictation-controls">
        {voice.supported ? (
          <>
            <button
              type="button"
              className="text-button"
              onClick={voice.listening ? voice.stop : voice.start}
            >
              <Mic size={16} />
              {voice.listening ? 'Parar ditado' : 'Ditar mensagem'}
            </button>
            {voice.listening && (
              <button type="button" className="text-button" onClick={voice.cancel}>
                Cancelar ditado
              </button>
            )}
            <small>O navegador pode processar sua voz remotamente. O app não armazena áudio.</small>
          </>
        ) : (
          <small>Ditado indisponível neste navegador. Você pode digitar normalmente.</small>
        )}
        {voice.notice && <span role="status">{voice.notice}</span>}
      </div>
      {text.length > 6000 && (
        <p role="alert" className="form-error">
          Reduza o texto para até 6.000 caracteres antes de enviar.
        </p>
      )}
      <form className="chat-composer" onSubmit={send}>
        <input
          aria-label="Sua mensagem"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            queue.pause === 'clarification'
              ? 'Responda à pergunta acima…'
              : processing
                ? 'Envie a próxima mensagem para a fila…'
                : 'Ex.: Finalizei #1'
          }
          maxLength={6000}
          disabled={busy || voice.listening}
        />
        <button
          className="button primary"
          aria-label="Enviar mensagem"
          disabled={busy || voice.listening || !text.trim() || text.length > 6000}
        >
          <Send size={18} />
        </button>
      </form>
      <div className="chat-footer">
        <span>
          A IA interpreta o pedido. A agenda valida e executa as ações. O pedido continua no
          servidor se você sair. Mensagens em espera ficam apenas nesta tela e serão perdidas ao
          sair ou recarregar.
        </span>
        {(messages.length > 0 || queue.items.length > 0) &&
          (confirming ? (
            <span className="chat-clear-confirm">
              Apagar toda a conversa e descartar mensagens em espera?
              <button className="text-button danger" disabled={busy || processing} onClick={clear}>
                Apagar
              </button>
              <button className="text-button" disabled={busy} onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button className="text-button" onClick={() => setConfirming(true)}>
              <Trash2 size={14} />
              Apagar conversa
            </button>
          ))}
      </div>
    </section>
  );
}
