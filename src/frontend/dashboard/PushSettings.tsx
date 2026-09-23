'use client';

import { useEffect, useState } from 'react';
import { BellRing, BellOff, Send } from 'lucide-react';
import { api, ApiError } from './api';
import { registerWorker } from './offline';

type Status = 'loading' | 'unsupported' | 'unconfigured' | 'off' | 'on';
type Info = { publicKey: string | null; devices: number };

// A chave VAPID chega em base64url; o pushManager quer os bytes.
function bytes(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const iphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}
// Erros do navegador vêm em inglês e sem contexto; os nossos (ApiError e Error com texto
// próprio) já explicam o que fazer.
const message = (error: unknown, fallback: string) =>
  error instanceof ApiError || (error instanceof Error && error.name === 'Error')
    ? error.message
    : fallback;

export function PushSettings() {
  const [status, setStatus] = useState<Status>('loading');
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!supported()) return setStatus('unsupported');
      try {
        const loaded = await api<Info>('push');
        if (!active) return;
        setInfo(loaded);
        if (!loaded.publicKey) return setStatus('unconfigured');
        const subscription = await currentSubscription();
        localStorage.setItem('agenda:push', String(Boolean(subscription)));
        setStatus(subscription ? 'on' : 'off');
        // Reenvia a inscrição que o aparelho já tem: se o servidor a removeu (410 de um envio
        // antigo, banco restaurado), ela volta sem o usuário precisar desativar e ativar.
        if (subscription) await api('push/subscribe', { subscription: subscription.toJSON() });
      } catch (e) {
        if (active) {
          setStatus('off');
          setError(message(e, 'Não foi possível consultar os lembretes com o app fechado.'));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function run(task: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(false);
    }
  }
  const enable = () =>
    run(async () => {
      if (!info?.publicKey) return;
      if (
        Notification.permission !== 'granted' &&
        (await Notification.requestPermission()) !== 'granted'
      )
        throw new Error('Permita notificações nas configurações do navegador.');
      await registerWorker();
      const registration = await navigator.serviceWorker.ready;
      // Uma inscrição feita com chaves VAPID antigas não aceita a chave nova: começa do zero.
      await (await registration.pushManager.getSubscription())?.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes(info.publicKey),
      });
      await api('push/subscribe', { subscription: subscription.toJSON() });
      localStorage.setItem('agenda:push', 'true');
      setInfo(await api<Info>('push'));
      setStatus('on');
      setNotice('Ativado. Use “Enviar teste” para conferir.');
    }, 'Não foi possível ativar neste navegador.');
  const disable = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (subscription) {
        await api('push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      localStorage.setItem('agenda:push', 'false');
      setInfo(await api<Info>('push'));
      setStatus('off');
    }, 'Não foi possível desativar neste navegador.');
  const test = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (!subscription) throw new Error('Este aparelho não está inscrito. Ative de novo.');
      await api('push/test', { endpoint: subscription.endpoint });
      setNotice('Teste enviado. O aviso deve chegar em alguns segundos.');
    }, 'Não foi possível enviar o teste.');

  const statusText = {
    loading: 'Verificando…',
    unsupported: iphone()
      ? 'No iPhone, os lembretes com o app fechado só funcionam com a agenda na tela de início: toque em Compartilhar → Adicionar à Tela de Início e abra por lá.'
      : 'Este navegador não oferece notificações push.',
    unconfigured:
      'O servidor ainda não tem as chaves VAPID. Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT (npm run push:keys gera as chaves) e publique de novo.',
    off: 'Desativado neste aparelho.',
    on: 'Ativo neste aparelho.',
  }[status];
  return (
    <>
      <div className="setting-title">
        <BellRing size={20} />
        <h3>Lembretes com o app fechado</h3>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-copy" role="status">
        {statusText}
        {info && info.devices > 0 && (status === 'on' || status === 'off')
          ? ` ${info.devices} aparelho(s) inscrito(s) no total.`
          : ''}
        {notice ? ` ${notice}` : ''}
      </p>
      {(status === 'on' || status === 'off') && (
        <div className="dialog-actions">
          {status === 'off' ? (
            <button className="button secondary" type="button" disabled={busy} onClick={enable}>
              <BellRing size={16} />
              Ativar neste aparelho
            </button>
          ) : (
            <>
              <button className="button secondary" type="button" disabled={busy} onClick={test}>
                <Send size={16} />
                Enviar teste
              </button>
              <button className="button secondary" type="button" disabled={busy} onClick={disable}>
                <BellOff size={16} />
                Desativar
              </button>
            </>
          )}
        </div>
      )}
      <p className="field-help">
        O servidor envia o aviso na hora do lembrete, mesmo com a agenda fechada, para cada aparelho
        ativado. O aviso mostra o título da tarefa. No iPhone e no iPad, exige a agenda adicionada à
        tela de início (iOS 16.4 ou mais recente).
      </p>
    </>
  );
}
