'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ListTodo, LoaderCircle, MessageCircle, Send, Trash2, Mic } from 'lucide-react';
import { useChatQueue } from './useChatQueue';
import { useDictation } from './useDictation';
import { AssistantReply } from './AssistantReply';
import { api } from './api';
import { statusLabels } from './format';
import type { Data } from './types';

const EXAMPLES = [
  'Anota: comprar pilhas',
  'Quais tarefas eu tenho pro dia 24?',
  'Adicione revisar o artigo em Estudos',
  'Finalizei #1',
  'Como foi minha semana?',
];

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
  const queue = useChatQueue(data, refresh, offline);
  const voice = useDictation(text, setText);
  const messages = [...(data?.messages.filter((m) => m.channel === 'web') ?? [])].reverse();
  const processing = queue.serverBusy || queue.items.some((i) => i.status === 'running');
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, queue.items.length, processing]);
  function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || text.length > 6000 || voice.listening || busy) return;
    queue.enqueue(text);
    setText('');
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
      <div className="chat-messages">
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
        {messages.map((m) => (
          <div className="chat-pair" key={m.id}>
            {m.body && <div className="bubble user">{m.body}</div>}
            <small className="message-status">
              {m.status === 'done' ? 'Concluída' : statusLabels[m.status]}
            </small>
            {m.reply ? (
              <div className="bubble assistant">
                <span className="assistant-name">
                  <ListTodo size={14} />
                  AgendaMagna
                </span>
                <AssistantReply text={m.reply} />
              </div>
            ) : (
              <div className="bubble assistant muted">
                {m.error ?? statusLabels[m.status] ?? 'Aguardando processamento'}
              </div>
            )}
          </div>
        ))}
        {queue.items
          .filter((i) => i.status !== 'done')
          .map((item) => (
            <div className="chat-pair queue-item" key={item.id}>
              {!messages.some((m) => m.id === item.serverId) && (
                <div className="bubble user">{item.text}</div>
              )}
              <div className="queue-status" role="status">
                {item.status === 'waiting'
                  ? `Em espera · posição ${queue.items.filter((i) => i.status === 'waiting').findIndex((i) => i.id === item.id) + 1}`
                  : item.status === 'running'
                    ? 'Executando'
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
            </div>
          ))}
        {(busy || processing) && (
          <div className="chat-typing">
            <LoaderCircle size={14} className="spin" />
            Executando o pedido atual. Você pode enviar outras mensagens para a fila.
          </div>
        )}
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
