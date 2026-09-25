'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Data } from './types';
export type QueuedMessage = {
  id: string;
  text: string;
  status: 'waiting' | 'running' | 'done' | 'error';
  serverId?: string;
  error?: string;
};
type Accepted = { id: string; status: string; error?: string | null };
export function useChatQueue(data: Data | null, refresh: () => Promise<void>, offline: boolean) {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const [pause, setPause] = useState<'error' | 'clarification' | null>(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  const [ready, setReady] = useState(false);
  const [externalId, setExternalId] = useState<string | null>(null);
  const serverBusy = !!data?.messages.some((m) => m.channel === 'web' && m.status === 'processing');
  const pending = items.some(
    (i) => i.status === 'waiting' || i.status === 'running' || i.status === 'error',
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!data || ready) return;
    setReady(true);
    if (data.messages.find((m) => m.channel === 'web')?.status === 'clarification')
      setPause('clarification');
  }, [data, ready]);
  // Um pedido já enviado em outra visita continua no servidor. Sua pergunta também
  // deve pausar os itens locais, sem consumir uma mensagem pendente como resposta.
  useEffect(() => {
    const active = data?.messages.find((m) => m.channel === 'web' && m.status === 'processing');
    if (active && !items.some((i) => i.status === 'running' || i.serverId === active.id))
      setExternalId(active.id);
    if (!externalId || active) return;
    const result = data?.messages.find((m) => m.id === externalId);
    if (result) {
      setPause(
        result.status === 'clarification'
          ? 'clarification'
          : result.status === 'failed'
            ? 'error'
            : null,
      );
      setExternalId(null);
    }
  }, [data, items, externalId]);
  function finish(id: string, r: Accepted) {
    if (!mounted.current) return;
    if (r.status === 'processing') {
      setItems((all) => all.map((i) => (i.id === id ? { ...i, serverId: r.id } : i)));
      return;
    }
    setItems((all) =>
      all.map((i) =>
        i.id === id
          ? {
              ...i,
              serverId: r.id,
              status: r.status === 'failed' ? 'error' : 'done',
              error: r.error ?? undefined,
            }
          : i,
      ),
    );
    setPause(
      r.status === 'failed' ? 'error' : r.status === 'clarification' ? 'clarification' : null,
    );
  }
  useEffect(() => {
    const active = items.find((i) => i.status === 'running' && i.serverId);
    if (!active) return;
    const message = data?.messages.find((m) => m.id === active.serverId);
    if (message && message.status !== 'processing') finish(active.id, message);
  }, [data, items]);
  useEffect(() => {
    if (
      !data ||
      !ready ||
      externalId ||
      offline ||
      pause ||
      serverBusy ||
      sending.current ||
      items.some((i) => i.status === 'running')
    )
      return;
    const next = items.find((i) => i.status === 'waiting');
    if (!next) return;
    sending.current = true;
    setItems((all) =>
      all.map((i) => (i.id === next.id ? { ...i, status: 'running', error: undefined } : i)),
    );
    void (async () => {
      try {
        const result = await api<Accepted>('chat', { text: next.text, requestId: next.id });
        await refresh();
        finish(next.id, result);
      } catch (error) {
        if (mounted.current) {
          setItems((all) =>
            all.map((i) =>
              i.id === next.id ? { ...i, status: 'error', error: (error as Error).message } : i,
            ),
          );
          setPause('error');
        }
        await refresh();
      } finally {
        sending.current = false;
      }
    })();
  }, [items, data, ready, externalId, offline, pause, serverBusy, refresh]);
  // A resposta pode estar sendo reescrita depois de o pedido terminar: a consulta continua até
  // a versão final chegar.
  const polishing = !!data?.messages.some((m) => m.channel === 'web' && m.stage === 'writing');
  useEffect(() => {
    if (!serverBusy && !polishing && !items.some((i) => i.status === 'running')) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [serverBusy, polishing, items, refresh]);
  useEffect(() => {
    if (!pending && !serverBusy) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const leave = (e: Event) => {
      if (
        !window.confirm(
          'Sair do chat? Mensagens em espera serão descartadas. O pedido já enviado continua no servidor.',
        )
      )
        e.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('agenda:leave-chat', leave);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('agenda:leave-chat', leave);
    };
  }, [pending, serverBusy]);
  return {
    items,
    pause,
    pending,
    serverBusy,
    enqueue(text: string) {
      const item: QueuedMessage = { id: crypto.randomUUID(), text: text.trim(), status: 'waiting' };
      if (pause === 'clarification') {
        setItems((all) => [item, ...all]);
        setPause(null);
      } else setItems((all) => [...all, item]);
    },
    remove(id: string) {
      setItems((all) => all.filter((i) => i.id !== id || i.status === 'running'));
    },
    retry(id: string) {
      setItems((all) =>
        all.map((i) =>
          i.id === id && i.status === 'error'
            ? { ...i, status: 'waiting', serverId: undefined, error: undefined }
            : i,
        ),
      );
      setPause(null);
    },
    discard(id: string) {
      setItems((all) => all.filter((i) => i.id !== id));
      setPause(null);
    },
    resume() {
      setPause(null);
    },
    reset() {
      setItems([]);
      setPause(null);
    },
  };
}
