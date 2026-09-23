'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Paperclip } from 'lucide-react';
import type { NoteFile, NotesPage, NoteWithFiles } from '@/backend/notes/types';
import { api } from './api';
import { timestamp } from './format';

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 10;
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function Notes({ offline }: { offline: boolean }) {
  const [list, setList] = useState<NotesPage | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<NoteWithFiles | 'new' | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (offline || !navigator.onLine) {
      setList(null);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (search.trim()) params.set('search', search.trim());
      const result = await api<NotesPage>(`notes?${params}`);
      if (current === generation.current) {
        setList(result);
        setError('');
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [offline, page, search]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);
  if (offline)
    return (
      <section className="notes-view">
        <h1>Anotações</h1>
        <p role="status">
          Conecte-se para ler ou escrever suas anotações. Elas não ficam disponíveis offline.
        </p>
      </section>
    );
  // O editor ocupa o lugar da lista em vez de abrir uma janela: texto longo e anexos pedem a
  // página inteira, e voltar para a lista é um clique.
  if (open)
    return (
      <section className="notes-view" aria-label={open === 'new' ? 'Nova anotação' : 'Anotação'}>
        <NoteEditor
          note={open === 'new' ? undefined : open}
          // Anexos são gravados na hora: voltar sem salvar o texto ainda precisa atualizar a
          // lista, senão a contagem de arquivos do cartão fica velha.
          close={() => {
            setOpen(null);
            void load();
          }}
          saved={(note) => setOpen(note)}
          done={() => {
            setOpen(null);
            void load();
          }}
          reload={async (id) => setOpen(await api<NoteWithFiles>(`notes/note?note=${id}`))}
        />
      </section>
    );
  return (
    <section className="notes-view" aria-label="Anotações">
      <div className="page-heading">
        <div>
          <h1>Anotações</h1>
          <p>Textos soltos e arquivos, sem prazo nem cobrança.</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" disabled={loading} onClick={() => void load()}>
            Atualizar anotações
          </button>
          <button className="button primary" onClick={() => setOpen('new')}>
            Nova anotação
          </button>
        </div>
      </div>
      <label className="notes-search">
        Buscar nas anotações
        <input
          value={search}
          placeholder="Título ou trecho do texto"
          aria-keyshortcuts="/"
          data-shortcut-search
          maxLength={200}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Atualizando anotações…</p>}
      {list && !list.notes.length && (
        <p>Nenhuma anotação{search.trim() ? ' para essa busca' : ' ainda'}.</p>
      )}
      <div className="notes-list">
        {list?.notes.map((note) => (
          <button
            className="note-card"
            key={note.id}
            onClick={async () => {
              try {
                setOpen(await api<NoteWithFiles>(`notes/note?note=${note.id}`));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <strong>{note.title}</strong>
            <span>{note.body.slice(0, 160) || 'Sem texto'}</span>
            <small>
              Atualizada em {timestamp(note.updatedAt)}
              {note.fileCount ? ` · ${note.fileCount} arquivo(s)` : ''}
            </small>
          </button>
        ))}
      </div>
      {list && list.total > 20 && (
        <div className="finance-pagination">
          <button
            className="button secondary"
            disabled={page === 1 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            Anterior
          </button>
          <span>
            Página {page} · {list.total} anotação(ões)
          </span>
          <button
            className="button secondary"
            disabled={page * 20 >= list.total || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </button>
        </div>
      )}
    </section>
  );
}

function NoteEditor({
  note,
  close,
  saved,
  done,
  reload,
}: {
  note?: NoteWithFiles;
  close: () => void;
  saved: (note: NoteWithFiles) => void;
  done: () => void;
  reload: (id: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Só o texto conta: anexos já vão para o servidor na hora e não se perdem ao sair.
  const dirty = note
    ? title !== note.title || body !== note.body
    : title.trim() !== '' || body.trim() !== '';
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(value: { title: string; body: string }) {
    const result = await api<NoteWithFiles>('notes', {
      ...(note ? { id: note.id, expectedVersion: note.version } : {}),
      ...value,
    });
    saved(result);
    return result;
  }
  async function attach(files: File[]) {
    if (!files.length) return;
    if (files.some((file) => file.size > MAX_FILE_BYTES))
      throw new Error('Cada arquivo pode ter até 3 MB.');
    if ((note?.files.length ?? 0) + files.length > MAX_FILES)
      throw new Error(`Cada anotação aceita até ${MAX_FILES} arquivos.`);
    // Arquivo precisa de uma anotação no servidor para se pendurar; na nova, salvar primeiro
    // evita pedir à pessoa um passo que ela não pediu. Sem título vira "Sem título".
    let target = note;
    let created = '';
    if (!target) {
      const named = title.trim() || 'Sem título';
      setTitle(named);
      target = await save({ title: named, body });
      created = 'Anotação criada. ';
    }
    for (const file of files) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 8192)
        binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
      await api('notes/file', {
        note: target.id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        content: btoa(binary),
      });
    }
    await reload(target.id);
    setNotice(
      `${created}${files.length === 1 ? `${files[0].name} anexado.` : `${files.length} arquivos anexados.`}`,
    );
  }
  async function download(file: NoteFile) {
    const saved = await api<NoteFile & { content: string }>(`notes/file?file=${file.id}`);
    const bytes = Uint8Array.from(atob(saved.content), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: saved.type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = saved.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <form
      className="note-page"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const isNew = !note;
          await save({ title, body });
          setNotice(isNew ? 'Anotação criada.' : 'Anotação salva.');
        });
      }}
    >
      <fieldset disabled={busy}>
        <header className="note-page-bar">
          <button
            type="button"
            className="text-button"
            aria-label="Voltar para anotações"
            onClick={() => {
              if (dirty && !window.confirm('Sair sem salvar as alterações do texto?')) return;
              close();
            }}
          >
            <ArrowLeft size={16} /> Anotações
          </button>
          <span className="note-page-state">
            {busy
              ? 'Salvando…'
              : dirty
                ? 'Alterações não salvas'
                : note
                  ? `Atualizada em ${timestamp(note.updatedAt)}`
                  : 'Nova anotação'}
          </span>
          <div className="note-page-actions">
            {note && (
              <button
                type="button"
                className="button secondary danger"
                onClick={() =>
                  void run(async () => {
                    if (!window.confirm(`Excluir ${note.title} e seus arquivos?`)) return;
                    await api('notes/delete', { note: note.id });
                    done();
                  })
                }
              >
                Excluir anotação
              </button>
            )}
            <button className="button primary">Salvar anotação</button>
          </div>
        </header>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="note-page-notice" role="status">
            {notice}
          </p>
        )}
        <div className="note-page-grid">
          <div className="note-page-main">
            <input
              className="note-page-title"
              aria-label="Título"
              placeholder="Título"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="note-page-body"
              aria-label="Texto"
              maxLength={20000}
              placeholder="Escreva o que quiser guardar."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <small className="note-page-count">{body.length}/20.000 caracteres</small>
          </div>
          <section
            className={`note-files${dragging ? ' dragging' : ''}`}
            aria-label="Arquivos"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const files = Array.from(e.dataTransfer.files);
              if (files.length) void run(() => attach(files));
            }}
          >
            <h2>
              <Paperclip size={15} /> Arquivos
            </h2>
            {!note?.files.length && <p className="note-files-empty">Nenhum arquivo anexado.</p>}
            {note?.files.map((file) => (
              <div className="note-file-row" key={file.id}>
                <span>
                  {file.name} · {size(file.size)}
                </span>
                <div className="finance-row-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void run(() => download(file))}
                  >
                    Baixar
                  </button>
                  <button
                    type="button"
                    className="text-button danger"
                    onClick={() =>
                      void run(async () => {
                        if (!window.confirm(`Remover ${file.name}?`)) return;
                        await api('notes/file/delete', { file: file.id });
                        await reload(note!.id);
                      })
                    }
                  >
                    Remover
                  </button>
                </div>
              </div>
            ))}
            <input
              id="note-file"
              className="note-file-input"
              type="file"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) void run(() => attach(files));
              }}
            />
            <label htmlFor="note-file" className="button secondary">
              Anexar arquivo
            </label>
            <p className="note-files-help">
              Arraste arquivos para cá ou escolha. Até 3 MB cada, {MAX_FILES} por anotação.
              {!note && ' Anexar salva a anotação.'}
            </p>
          </section>
        </div>
      </fieldset>
    </form>
  );
}
