'use client';
import { useState } from 'react';
import { api } from './api';
import { Dialog } from './Dialog';
import type { Data } from './types';
export function BackupDialog({
  data,
  close,
  refresh,
}: {
  data: Data;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [backup, setBackup] = useState<{
    version: number;
    tasks: unknown[];
    groups: unknown[];
    finance?: {
      categories: unknown[];
      entries: unknown[];
      templates?: unknown[];
      plan?: unknown[];
    };
    goals?: { goals: unknown[]; logs: unknown[] };
  } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(data.settings.revision);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true);
    setError('');
    try {
      const value = await api('backup');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `agenda-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    setError('');
    try {
      await api('backup/import', {
        backup,
        expectedRevision: previewRevision,
        password,
        code: code || undefined,
      });
      await refresh();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Exportar e restaurar agenda"
      subtitle="O arquivo contém tarefas, grupos, finanças, metas e o prazo da lixeira. Não inclui senhas nem chaves de IA."
      close={close}
    >
      <div className="editor-form">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button secondary" disabled={busy} onClick={() => void download()}>
          Baixar cópia da agenda
        </button>
        <p>O arquivo contém seus dados pessoais. Guarde-o em um local protegido.</p>
        <label htmlFor="backup-file">Arquivo para restaurar (JSON, até 2 MB)</label>
        <input
          id="backup-file"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={async (e) => {
            setBackup(null);
            setConfirmed(false);
            setError('');
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              if (file.size > 2 * 1024 * 1024) throw new Error('O arquivo excede 2 MB.');
              const value = JSON.parse(await file.text());
              if (
                value.format !== 'AgendaMagno' ||
                ![1, 2, 3].includes(value.version) ||
                (value.version === 3 &&
                  (!Array.isArray(value.goals?.goals) || !Array.isArray(value.goals?.logs))) ||
                (value.version >= 2 &&
                  (!Array.isArray(value.finance?.categories) ||
                    !Array.isArray(value.finance?.entries))) ||
                !Array.isArray(value.tasks) ||
                !Array.isArray(value.groups)
              )
                throw new Error('Formato de backup inválido.');
              setBackup(value);
              setPreviewRevision(data.settings.revision);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
        {backup && (
          <div className="confirmation-panel">
            <h3>Revisar restauração</h3>
            <p>
              A agenda atual tem {data.tasks.length} tarefas e {data.groups.length} grupos. Será
              substituída por {backup.tasks.length} tarefas e {backup.groups.length} grupos do
              arquivo. O histórico de ações e a conversa atual serão limpos.
            </p>
            <p>
              {backup.version >= 2
                ? `Todos os lançamentos, categorias e modelos financeiros atuais serão substituídos por ${backup.finance!.entries.length} lançamentos, ${backup.finance!.categories.length} categorias e ${backup.finance!.templates?.length ?? 0} modelos do arquivo.${backup.finance!.plan ? ` O planejamento atual será trocado pelos ${backup.finance!.plan.length} itens do arquivo.` : ' O planejamento atual será mantido.'}`
                : 'Este arquivo é versão 1: o financeiro atual será preservado.'}
            </p>
            <p>
              {backup.goals
                ? `As metas atuais serão substituídas por ${backup.goals.goals.length} metas e ${backup.goals.logs.length} registros do arquivo.`
                : 'Este arquivo não tem metas: as metas atuais serão preservadas.'}
            </p>
            <p>
              Anotações e seus arquivos não entram no backup: a restauração não os apaga nem os
              devolve.
            </p>
            <p>Baixe uma cópia da agenda atual antes de continuar.</p>
            <label htmlFor="backup-password">Senha atual</label>
            <input
              id="backup-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={256}
            />
            <label htmlFor="backup-code">Código de duas etapas, se ativado</label>
            <input
              id="backup-code"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={64}
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Confirmo a substituição da agenda atual
            </label>
            <button
              className="button danger"
              disabled={busy || !confirmed || !password}
              onClick={() => void restore()}
            >
              Restaurar arquivo
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
