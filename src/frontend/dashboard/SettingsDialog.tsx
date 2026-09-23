'use client';

import { useEffect, useState } from 'react';
import { Check, MessageCircle, Monitor, Moon, Sparkles, Sun, Trash2 } from 'lucide-react';
import { offlineEnabled, remember, clearOffline, registerWorker } from './offline';
import { Dialog } from './Dialog';
import { PushSettings } from './PushSettings';
import { applyTheme, readTheme, type Theme } from './theme';
import type { Action, Data } from './types';

export function SettingsDialog({
  data,
  busy,
  close,
  action,
  openLlm,
  openSecurity,
  openBackup,
}: {
  data: Data | null;
  busy: boolean;
  close: () => void;
  action: Action;
  openLlm: () => void;
  openSecurity: () => void;
  openBackup: () => void;
}) {
  const [offline, setOffline] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  useEffect(() => {
    setOffline(offlineEnabled());
    setNotifications(localStorage.getItem('agenda:notifications') === 'true');
  }, []);
  const [days, setDays] = useState(data?.settings.retentionDays ?? 30);
  const [natural, setNatural] = useState(data?.settings.naturalReply !== false);
  // 'system' até o primeiro render no cliente: no servidor não dá para ler a escolha guardada.
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => setTheme(readTheme()), []);
  function chooseTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }
  return (
    <Dialog title="Do seu jeito" subtitle="Ajustes simples para sua organização." close={close}>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action([
            { op: 'set_retention', days },
            { op: 'set_natural_reply', enabled: natural },
          ]);
        }}
      >
        <div className="setting-title">
          <Sun size={20} />
          <h3>Aparência</h3>
        </div>
        <p className="settings-copy">
          Vale neste aparelho. “Seguir o sistema” acompanha o modo claro ou escuro do seu computador
          ou celular.
        </p>
        <div className="theme-choice" role="group" aria-label="Tema">
          {(
            [
              ['light', 'Claro', <Sun key="l" size={16} />],
              ['dark', 'Escuro', <Moon key="d" size={16} />],
              ['system', 'Seguir o sistema', <Monitor key="s" size={16} />],
            ] as const
          ).map(([value, label, icon]) => (
            <button
              key={value}
              type="button"
              className={theme === value ? 'selected' : ''}
              aria-pressed={theme === value}
              onClick={() => chooseTheme(value)}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        <div className="setting-title">
          <h3>Este dispositivo</h3>
        </div>
        {deviceError && (
          <p className="form-error" role="alert">
            {deviceError}
          </p>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={offline}
            onChange={async (e) => {
              const enabled = e.target.checked;
              setDeviceError('');
              try {
                if (
                  !enabled &&
                  !window.confirm(
                    'Desativar o modo offline e apagar a cópia local e alterações ainda não sincronizadas?',
                  )
                )
                  return;
                setOffline(enabled);
                localStorage.setItem('agenda:offline-enabled', String(enabled));
                if (enabled) {
                  await registerWorker();
                  if (data) await remember(data);
                } else await clearOffline();
                setOffline(enabled);
                window.dispatchEvent(new Event('agenda:offline-setting'));
              } catch {
                setOffline(false);
                localStorage.setItem('agenda:offline-enabled', 'false');
                setDeviceError(
                  'Não foi possível configurar o armazenamento offline neste navegador.',
                );
              }
            }}
          />
          Permitir acesso offline neste dispositivo
        </label>
        <p className="field-help">
          Salva uma cópia da agenda neste navegador. Use em aparelho pessoal com bloqueio de tela.
          Criar e editar tarefas funciona sem internet; IA, grupos e segurança exigem conexão.
          Tarefas novas podem ser editadas após sincronizar.
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={notifications}
            onChange={async (e) => {
              setDeviceError('');
              const enabled = e.target.checked;
              setNotifications(enabled);
              if (enabled) {
                if (!('Notification' in window)) {
                  setNotifications(false);
                  setDeviceError('Este navegador não oferece notificações.');
                  return;
                }
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                  setNotifications(false);
                  setDeviceError('Permita notificações nas configurações do navegador.');
                  return;
                }
                await registerWorker();
              }
              localStorage.setItem('agenda:notifications', String(enabled));
              setNotifications(enabled);
            }}
          />
          Ativar notificações de lembretes
        </label>
        <p className="field-help">
          Os avisos usam o horário de cada tarefa e podem exibir seu título. Esta opção avisa
          enquanto a agenda está aberta; para avisar com ela fechada, ative a seção abaixo.
        </p>
        <PushSettings />
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={openSecurity}>
            Segurança e dispositivos
          </button>
          <button className="button secondary" type="button" onClick={openBackup}>
            Exportar e restaurar
          </button>
        </div>
        <div className="setting-title">
          <MessageCircle size={20} />
          <h3>Respostas do assistente</h3>
        </div>
        <label className="check-label">
          <input type="checkbox" checked={natural} onChange={(e) => setNatural(e.target.checked)} />
          Reescrever as respostas em linguagem natural
        </label>
        <p className="field-help">
          A agenda monta a resposta a partir do que realmente aconteceu e a IA reescreve só a
          redação: códigos, datas e nomes de tarefas são conferidos e não mudam. É uma segunda
          chamada por mensagem, que conta nos limites diários. Desligado, a resposta chega no
          formato direto, sem chamada extra.
        </p>
        <div className="setting-title">
          <Trash2 size={20} />
          <h3>Tempo na lixeira</h3>
        </div>
        <p className="settings-copy">
          Ao descartar uma tarefa, ela fica na lixeira antes de ser excluída definitivamente.
        </p>
        <label htmlFor="retention">Excluir após quantos dias?</label>
        <input
          id="retention"
          type="number"
          min={1}
          max={3650}
          required
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
        <p className="field-help">
          Vale apenas para novas entradas. Tarefas que já estão na lixeira mantêm a data informada.
          Concluídas ficam guardadas fora da lixeira.
        </p>
        <div className="settings-facts">
          <span>
            Fuso horário<strong>America/Bahia</strong>
          </span>
          <span>
            Armazenamento
            <strong>
              {data?.storage === 'local' ? 'Local · desenvolvimento' : 'PostgreSQL · Neon'}
            </strong>
          </span>
          <span>
            Interpretação de mensagens
            <strong>{data?.llm === 'none' ? 'Sem IA — só frases exatas' : 'IA cadastrada'}</strong>
          </span>
        </div>
        <button
          type="button"
          className="button secondary full settings-llm-button"
          onClick={openLlm}
        >
          <Sparkles size={16} />
          Cadastrar e organizar modelos de IA
        </button>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={close}>
            Cancelar
          </button>
          <button className="button primary" disabled={busy}>
            <Check size={16} />
            Salvar preferência
          </button>
        </div>
      </form>
    </Dialog>
  );
}
