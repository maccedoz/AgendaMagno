'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  Clock3,
  Inbox,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  MoreHorizontal,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { Command } from '@/backend/domain';
import LlmSettings from '@/frontend/llm-settings';
import { api } from './api';
import { due, labels, overdue, priorityLabels, timestamp, today, urgency } from './format';
import { Brand } from './Brand';
import { Dialog } from './Dialog';
import { Login } from './Login';
import { TaskDialog } from './TaskDialog';
import { Calendar } from './Calendar';
import { BulkActions } from './BulkActions';
import { SecurityDialog } from './SecurityDialog';
import { BackupDialog } from './BackupDialog';
import {
  cached,
  clearOffline,
  enqueue,
  pending,
  project,
  queueLock,
  registerWorker,
  remember,
  reminderAt,
  setPending,
} from './offline';
import { GroupDialog, groupIcons } from './GroupDialog';
import { SettingsDialog } from './SettingsDialog';
import { Finance } from './Finance';
import { Notes } from './Notes';
import { Assistant } from './Assistant';
import { ActivityDialog } from './ActivityDialog';
import type { Data, Modal, View } from './types';

export default function Dashboard() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [data, setData] = useState<Data | null>(null);
  // A conversa abre primeiro: é por onde a maior parte dos pedidos entra, e o painel continua
  // a um clique na navegação lateral.
  const [view, setView] = useState<View>('assistant');
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [mobile, setMobile] = useState(false);
  // Recolher a barra lateral é preferência deste aparelho, e não do espaço: a mesma agenda
  // aberta no notebook e no celular não precisa da mesma largura útil.
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [tag, setTag] = useState('');
  const [isOffline, setIsOffline] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [syncError, setSyncError] = useState('');
  const refreshing = useRef<Promise<void> | null>(null);
  const [page, setPage] = useState(1);
  const refresh = useCallback(async () => {
    const operation = (refreshing.current ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        setLoading(true);
        try {
          if (!navigator.onLine) throw new TypeError('Sem conexão');
          await queueLock(async () => {
            let queue = await pending();
            setSyncError('');
            for (const item of queue) {
              try {
                const result = await api<{ clarification: boolean; reply: string }>('actions', {
                  commands: item.commands,
                  requestId: item.id,
                });
                if (result.clarification) throw new Error(result.reply);
                queue = queue.filter((q) => q.id !== item.id);
                await setPending(queue);
              } catch (e) {
                if (e instanceof TypeError) throw e;
                setSyncError((e as Error).message);
                break;
              }
            }
          });
          const fresh = await api<Data>('state');
          await remember(fresh);
          const queue = await pending();
          setData(project(fresh, queue));
          setQueueCount(queue.length);
          setIsOffline(false);
        } catch (e) {
          if (e instanceof TypeError) {
            const stored = await cached();
            if (stored) {
              const queue = await pending();
              setData(project(stored, queue));
              setQueueCount(queue.length);
              setIsOffline(true);
            } else
              setNotice({
                text: 'Sem conexão e sem cópia offline válida. Conecte-se para continuar.',
                error: true,
              });
          } else setNotice({ text: (e as Error).message, error: true });
        } finally {
          setLoading(false);
        }
      });
    refreshing.current = operation;
    try {
      await operation;
    } finally {
      if (refreshing.current === operation) refreshing.current = null;
    }
  }, []);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('agenda:sidebar') === 'collapsed');
    } catch {
      /* Navegador sem armazenamento local: a barra abre expandida. */
    }
  }, []);
  function toggleSidebar() {
    setCollapsed((current) => {
      try {
        localStorage.setItem('agenda:sidebar', current ? 'open' : 'collapsed');
      } catch {
        /* A escolha vale para esta sessão mesmo sem poder ser guardada. */
      }
      return !current;
    });
  }
  useEffect(() => {
    void registerWorker().catch(() => {});
    api<{ authenticated: boolean; expiresAt: string | null; trusted: boolean }>('auth')
      .then(async (r) => {
        if (r.authenticated && r.expiresAt) {
          sessionStorage.setItem('agenda:expires', r.expiresAt);
          if (r.trusted) localStorage.setItem('agenda:expires', r.expiresAt);
        } else await clearOffline();
        setAuth(r.authenticated);
      })
      .catch(async () => {
        setAuth(Boolean(await cached()));
      });
    const logout = () => {
      setAuth(false);
      setData(null);
      setModal(null);
      void clearOffline();
      localStorage.removeItem('agenda:expires');
      sessionStorage.removeItem('agenda:expires');
    };
    window.addEventListener('agenda:logout', logout);
    return () => window.removeEventListener('agenda:logout', logout);
  }, []);
  useEffect(() => {
    if (auth) {
      void api<{ expiresAt: string; trusted: boolean }>('auth')
        .then((r) => {
          if (r.expiresAt) {
            sessionStorage.setItem('agenda:expires', r.expiresAt);
            if (r.trusted) localStorage.setItem('agenda:expires', r.expiresAt);
          }
          return refresh();
        })
        .catch(() => refresh());
      const tick = () => {
        if (document.visibilityState === 'visible') void refresh();
      };
      const timer = setInterval(tick, 15000);
      window.addEventListener('online', tick);
      window.addEventListener('focus', tick);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('agenda:offline-setting', tick);
      return () => {
        clearInterval(timer);
        window.removeEventListener('online', tick);
        window.removeEventListener('focus', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('agenda:offline-setting', tick);
      };
    }
  }, [auth, refresh]);
  useEffect(() => {
    if (data && view.startsWith('group:') && !data.groups.some((g) => g.id === view.slice(6)))
      setView('inbox');
  }, [data, view]);
  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [view, search, priority, status, tag]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!data) return;
    const notify = async () => {
      if (
        localStorage.getItem('agenda:notifications') !== 'true' ||
        !('Notification' in window) ||
        Notification.permission !== 'granted'
      )
        return;
      for (const task of data.tasks) {
        if (task.id < 0 || data.groups.some((g) => g.id === task.groupId && g.archivedAt)) continue;
        const at = reminderAt(task);
        if (at === null || at > Date.now() || Date.now() - at > 86400000) continue;
        const key = `agenda:reminder:${task.id}:${at}`;
        if (localStorage.getItem(key)) continue;
        try {
          const registration =
            'serviceWorker' in navigator
              ? await navigator.serviceWorker.getRegistration()
              : undefined;
          if (registration)
            await registration.showNotification('AgendaMagna · Lembrete', {
              body: task.title,
              icon: '/icon.svg',
              tag: key,
            });
          else new Notification('AgendaMagna · Lembrete', { body: task.title, tag: key });
          localStorage.setItem(key, 'sent');
        } catch {
          /* Permission may have changed while the page was open. */
        }
      }
    };
    void notify();
    const timer = setInterval(() => void notify(), 30000);
    return () => clearInterval(timer);
  }, [data]);
  async function action(commands: Command[], close = true) {
    setBusy(true);
    const requestId = crypto.randomUUID();
    try {
      if (!navigator.onLine || (await pending()).length) {
        await queueLock(() => enqueue(commands, requestId));
        await refresh();
        setNotice({
          text: 'Alteração salva neste dispositivo. Aguardando sincronização.',
          error: false,
        });
        if (close) setModal(null);
        return true;
      }
      const result = await api<{ reply: string; clarification: boolean }>('actions', {
        commands,
        requestId,
      });
      setNotice({ text: result.reply, error: result.clarification });
      if (result.clarification)
        window.dispatchEvent(new CustomEvent('agenda:error', { detail: result.reply }));
      await refresh();
      if (close && !result.clarification) setModal(null);
      return !result.clarification;
    } catch (e) {
      if (e instanceof TypeError) {
        try {
          await queueLock(() => enqueue(commands, requestId));
          await refresh();
          if (close) setModal(null);
          setNotice({
            text: 'Alteração salva offline. Será sincronizada ao reconectar.',
            error: false,
          });
          return true;
        } catch (error) {
          e = error;
        }
      }
      setNotice({ text: (e as Error).message, error: true });
      window.dispatchEvent(new CustomEvent('agenda:error', { detail: (e as Error).message }));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: View) {
    if (
      view === 'assistant' &&
      next !== 'assistant' &&
      !window.dispatchEvent(new Event('agenda:leave-chat', { cancelable: true }))
    )
      return;
    setView(next);
    setMobile(false);
    setSearch('');
    setPriority('');
    setStatus('');
    setTag('');
  }
  if (auth === null)
    return (
      <div className="loading-screen">
        <Brand />
        <LoaderCircle className="spin" />
        <span>Preparando seu espaço…</span>
      </div>
    );
  if (!auth) return <Login onLogin={() => setAuth(true)} />;
  const tasks = data?.tasks ?? [];
  const groups = [...(data?.groups ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
  );
  const active = tasks.filter(
    (t) =>
      !t.trashedAt &&
      t.status !== 'completed' &&
      !groups.some((g) => g.id === t.groupId && g.archivedAt),
  );
  const group = view.startsWith('group:') ? groups.find((g) => g.id === view.slice(6)) : undefined;
  const title = group?.name ?? labels[view] ?? 'Tarefas';
  const isTrash = view === 'trash';
  const filtered = tasks
    .filter((t) => {
      if (isTrash ? !t.trashedAt : t.trashedAt) return false;
      if (view === 'completed' ? t.status !== 'completed' : !isTrash && t.status === 'completed')
        return false;
      if (!group && !isTrash && groups.some((g) => g.id === t.groupId && g.archivedAt))
        return false;
      if (tag && !t.tags?.includes(tag)) return false;
      if (view === 'inbox' && t.groupId) return false;
      if (view === 'today' && t.dueDate !== today()) return false;
      if (view === 'overdue' && !overdue(t)) return false;
      if (view === 'no_date' && t.dueDate) return false;
      if (group && t.groupId !== group.id) return false;
      if (priority && t.priority !== priority) return false;
      if (status && t.status !== status) return false;
      const norm = (s: string) =>
        s
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
      return norm(`${t.title} ${t.description}`).includes(norm(search));
    })
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.id - a.id);
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages);
  const shown = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const issueCount =
    data?.messages.filter((m) => m.status === 'failed' || m.status === 'clarification').length ?? 0;
  const navItem = (key: View, label: string, icon: ReactNode, count?: number) => (
    <button className={`nav-item ${view === key ? 'selected' : ''}`} onClick={() => navigate(key)}>
      {icon}
      <span>{label}</span>
      {count !== undefined && <span className="nav-count">{count}</span>}
    </button>
  );
  return (
    <div className={`app-shell${collapsed ? ' collapsed' : ''}`}>
      {mobile && (
        <button
          className="mobile-scrim"
          aria-label="Fechar menu"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <Brand />
        <div className="workspace-label">
          <span className="workspace-avatar">M</span>
          <div>
            Meu espaço<small>Organização pessoal</small>
          </div>
          <span className="personal-tag">PESSOAL</span>
        </div>
        <nav aria-label="Navegação principal">
          <span className="nav-label">SUA AGENDA</span>
          {navItem('assistant', 'Assistente', <MessageCircle size={18} />)}
          {navItem('finance', 'Financeiro', <LayoutGrid size={18} />)}
          {navItem('notes', 'Anotações', <NotebookPen size={18} />)}
          {navItem('all', 'Todas as tarefas', <LayoutGrid size={18} />, active.length)}
          {navItem(
            'inbox',
            'Caixa de entrada',
            <Inbox size={18} />,
            active.filter((t) => !t.groupId).length,
          )}
          {navItem(
            'today',
            'Hoje',
            <Clock3 size={18} />,
            active.filter((t) => t.dueDate === today()).length,
          )}
          {navItem(
            'overdue',
            'Atrasadas',
            <ArrowDown size={18} />,
            active.filter((t) => overdue(t)).length,
          )}
          {navItem('no_date', 'Sem prazo', <ListTodo size={18} />)}
          {navItem('calendar', 'Calendário', <LayoutGrid size={18} />)}
          {navItem(
            'archived',
            'Grupos arquivados',
            <Inbox size={18} />,
            groups.filter((g) => g.archivedAt).length,
          )}
          <div className="nav-label group-label">
            MEUS GRUPOS
            <button
              className="icon-button tiny"
              aria-label="Criar grupo"
              onClick={() => setModal({ type: 'group' })}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="group-nav">
            {groups
              .filter((g) => !g.archivedAt)
              .map((g) => (
                <button
                  key={g.id}
                  className={`nav-item ${view === `group:${g.id}` ? 'selected' : ''}`}
                  onClick={() => navigate(`group:${g.id}`)}
                >
                  <span className={`group-symbol group-${g.color ?? 'sage'}`}>
                    {groupIcons[g.icon ?? 'folder']}
                  </span>
                  <span>{g.name}</span>
                  <span className="nav-count">
                    {active.filter((t) => t.groupId === g.id).length}
                  </span>
                </button>
              ))}
            {!groups.length && (
              <button className="empty-groups" onClick={() => setModal({ type: 'group' })}>
                + Seu primeiro grupo
              </button>
            )}
          </div>
          <div className="nav-divider" />
          {navItem(
            'completed',
            'Concluídas',
            <CheckCheck size={18} />,
            tasks.filter(
              (t) =>
                t.status === 'completed' &&
                !t.trashedAt &&
                !groups.some((g) => g.id === t.groupId && g.archivedAt),
            ).length,
          )}
          {navItem(
            'trash',
            'Lixeira',
            <Trash2 size={18} />,
            tasks.filter((t) => t.trashedAt).length,
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setModal({ type: 'llm' })}>
            <Sparkles size={18} />
            <span>Modelos de IA</span>
          </button>
          <button className="nav-item" onClick={() => setModal({ type: 'settings' })}>
            <Settings2 size={18} />
            <span>Configurações</span>
          </button>
          <button
            className="nav-item"
            onClick={async () => {
              try {
                if (!window.dispatchEvent(new Event('agenda:leave-chat', { cancelable: true })))
                  return;
                await api('logout', {});
                window.dispatchEvent(new Event('agenda:logout'));
              } catch (e) {
                setNotice({ text: (e as Error).message, error: true });
              }
            }}
          >
            <LogOut size={18} />
            <span>Sair</span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir menu"
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <button
              className="icon-button sidebar-toggle"
              aria-label={collapsed ? 'Mostrar menu lateral' : 'Ocultar menu lateral'}
              title={collapsed ? 'Mostrar menu lateral' : 'Ocultar menu lateral'}
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
            >
              {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
            <span>Meu espaço</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <span className="today-label">
              {new Intl.DateTimeFormat('pt-BR', {
                day: 'numeric',
                month: 'long',
                timeZone: 'America/Bahia',
              }).format(new Date())}
            </span>
            <button
              className="avatar"
              aria-label="Abrir configurações"
              onClick={() => setModal({ type: 'settings' })}
            >
              M
            </button>
          </div>
        </header>
        <main className={`main-content${view === 'assistant' ? ' assistant-main' : ''}`}>
          {view !== 'assistant' && view !== 'finance' && view !== 'notes' && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">UM PASSO DE CADA VEZ</span>
                  <div className="title-row">
                    <h1>{title}</h1>
                    {group && (
                      <button
                        className="icon-button"
                        aria-label="Editar grupo"
                        onClick={() => setModal({ type: 'group', group })}
                      >
                        <Pencil size={17} />
                      </button>
                    )}
                  </div>
                  <p>
                    {isTrash
                      ? 'O que já passou também tem seu lugar. Restaure enquanto precisar.'
                      : group
                        ? 'Um espaço para transformar planos em próximos passos.'
                        : 'Tire da cabeça. Organize aqui. Siga no seu ritmo.'}
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    className="icon-button outlined"
                    aria-label="Atualizar tarefas"
                    title="Atualizar"
                    onClick={() => void refresh()}
                    disabled={loading}
                  >
                    <RefreshCw size={18} className={loading ? 'spin' : ''} />
                  </button>
                  <button className="button primary" onClick={() => setModal({ type: 'task' })}>
                    <Plus size={18} />
                    Nova tarefa
                  </button>
                </div>
              </section>
              <section className="stats" aria-label="Resumo da agenda">
                <button className="stat-card" onClick={() => navigate('all')}>
                  <span className="stat-icon sage">
                    <ListTodo size={20} />
                  </span>
                  <span>
                    <span className="stat-label">Tarefas ativas</span>
                    <strong>
                      {active.length}
                      <small>para seguir em frente</small>
                    </strong>
                  </span>
                  <span className="stat-corner">↗</span>
                </button>
                <button className="stat-card" onClick={() => navigate('today')}>
                  <span className="stat-icon sand">
                    <Clock3 size={20} />
                  </span>
                  <span>
                    <span className="stat-label">Para hoje</span>
                    <strong>
                      {active.filter((t) => t.dueDate === today()).length}
                      <small>um foco de cada vez</small>
                    </strong>
                  </span>
                  <span className="stat-corner">↗</span>
                </button>
                <button className="stat-card" onClick={() => navigate('completed')}>
                  <span className="stat-icon lilac">
                    <CheckCheck size={20} />
                  </span>
                  <span>
                    <span className="stat-label">Concluídas</span>
                    <strong>
                      {
                        tasks.filter(
                          (t) =>
                            t.status === 'completed' &&
                            !t.trashedAt &&
                            !groups.some((g) => g.id === t.groupId && g.archivedAt),
                        ).length
                      }
                      <small>guardadas no histórico</small>
                    </strong>
                  </span>
                  <span className="stat-corner">↗</span>
                </button>
              </section>
            </>
          )}
          {(isOffline || queueCount > 0) && (
            <div className="sync-banner" role="status">
              <strong>{isOffline ? 'Modo offline' : 'Sincronização pendente'}</strong>
              <span>{queueCount} alteração(ões) aguardando envio.</span>
              {syncError && (
                <p>
                  {syncError} As alterações pendentes não serão aplicadas até resolver o conflito.
                  Descarte-as para carregar os dados atuais e refaça a edição.
                </p>
              )}
              <button className="text-button" onClick={() => void refresh()}>
                Tentar sincronizar
              </button>
              {queueCount > 0 && (
                <button
                  className="text-button danger"
                  onClick={async () => {
                    if (
                      window.confirm(
                        'Descartar todas as alterações ainda não sincronizadas deste dispositivo?',
                      )
                    ) {
                      await queueLock(() => setPending([]));
                      await refresh();
                    }
                  }}
                >
                  Descartar pendências
                </button>
              )}
            </div>
          )}
          {view === 'assistant' ? (
            <Assistant data={data} refresh={refresh} offline={isOffline} />
          ) : view === 'finance' ? (
            <Finance
              offline={isOffline}
              revision={data?.settings.revision ?? 0}
              refresh={refresh}
            />
          ) : view === 'notes' ? (
            <Notes offline={isOffline} />
          ) : view === 'archived' ? (
            <section className="archive-list">
              <h2>Grupos arquivados</h2>
              {groups
                .filter((g) => g.archivedAt)
                .map((g) => (
                  <div className="session-item" key={g.id}>
                    <button className="text-button" onClick={() => navigate(`group:${g.id}`)}>
                      {groupIcons[g.icon ?? 'folder']} {g.name}
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => setModal({ type: 'group', group: g })}
                    >
                      Gerenciar grupo
                    </button>
                  </div>
                ))}
              {!groups.some((g) => g.archivedAt) && <p>Nenhum grupo arquivado.</p>}
            </section>
          ) : view === 'calendar' ? (
            <Calendar
              tasks={active}
              edit={(task) => setModal({ type: 'task', task })}
              action={action}
              busy={busy}
            />
          ) : (
            <section className="tasks-card">
              <div className="list-toolbar">
                <div className="list-heading">
                  <h2>{isTrash ? 'Seu histórico recente' : 'Seus próximos passos'}</h2>
                  <span className="count-pill">{filtered.length}</span>
                </div>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void action([{ op: 'undo' }], false)}
                >
                  <RotateCcw size={15} />
                  Desfazer
                </button>
              </div>
              <div className="filters">
                <label className="search-box">
                  <Search size={18} />
                  <input
                    type="search"
                    placeholder="Buscar título ou descrição…"
                    aria-label="Buscar tarefas"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      className="icon-button tiny"
                      aria-label="Limpar busca"
                      onClick={() => setSearch('')}
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
                <div className="filter-selects">
                  <select
                    aria-label="Filtrar prioridade"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    <option value="">Prioridade: todas</option>
                    <option value="high">Alta</option>
                    <option value="normal">Normal</option>
                    <option value="low">Baixa</option>
                  </select>
                  {!isTrash && (
                    <select
                      aria-label="Filtrar situação"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">Situação: todas</option>
                      <option value="pending">Pendente</option>
                      <option value="in_progress">Em andamento</option>
                    </select>
                  )}
                </div>
              </div>
              {isTrash && (
                <div className="trash-notice">
                  <Trash2 size={16} />
                  As tarefas permanecem aqui até a data de exclusão. Você pode restaurá-las antes
                  disso.
                </div>
              )}
              <div className="selection-toolbar">
                <label className="check-label">
                  <input
                    type="checkbox"
                    aria-label="Selecionar tarefas desta página"
                    checked={
                      shown.length > 0 &&
                      shown.filter((t) => t.id > 0).every((t) => selected.includes(t.id))
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? shown.filter((t) => t.id > 0).map((t) => t.id) : [],
                      )
                    }
                  />
                  Selecionar página
                </label>
                <select
                  aria-label="Filtrar etiqueta"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                >
                  <option value="">Todas as etiquetas</option>
                  {[...new Set(tasks.flatMap((t) => t.tags ?? []))].sort().map((tag) => (
                    <option key={tag}>{tag}</option>
                  ))}
                </select>
              </div>
              {selected.length > 0 && (
                <BulkActions
                  tasks={tasks.filter((t) => selected.includes(t.id))}
                  groups={groups}
                  clear={() => setSelected([])}
                  action={action}
                  busy={busy}
                />
              )}
              <div className="task-table">
                <div className="table-head">
                  <span>TAREFA</span>
                  <span>GRUPO</span>
                  <span>{isTrash ? 'EXCLUSÃO PREVISTA' : 'PRAZO'}</span>
                  <span>PRIORIDADE</span>
                  <span />
                </div>
                {!data ? (
                  <div className="empty-state">
                    <LoaderCircle className={loading ? 'spin' : ''} size={30} />
                    <h3>{loading ? 'Carregando sua agenda…' : 'Não foi possível carregar'}</h3>
                    <p>
                      {loading
                        ? 'Buscando seus próximos passos.'
                        : 'Confira a conexão e tente atualizar.'}
                    </p>
                    {!loading && (
                      <button className="button secondary" onClick={() => void refresh()}>
                        Tentar novamente
                      </button>
                    )}
                  </div>
                ) : shown.length ? (
                  shown.map((t) => (
                    <div
                      className={`task-row ${t.trashedAt ? 'trashed' : ''} ${isTrash ? '' : `urgency-${urgency(t) || 'none'} priority-row-${t.priority}`}`}
                      key={t.id}
                    >
                      <div className="task-primary">
                        <input
                          className="task-select"
                          type="checkbox"
                          aria-label={`Selecionar ${t.title}`}
                          disabled={t.id < 0 || busy}
                          checked={selected.includes(t.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, t.id].slice(0, 100)
                                : selected.filter((id) => id !== t.id),
                            )
                          }
                        />
                        {t.trashedAt || t.status === 'completed' ? (
                          <span className="completed-check">
                            {t.status === 'completed' ? <Check size={17} /> : <Trash2 size={16} />}
                          </span>
                        ) : (
                          <button
                            className={`task-check ${t.status === 'in_progress' ? 'in-progress' : ''}`}
                            aria-label={`Concluir ${t.title}`}
                            disabled={busy}
                            onClick={() =>
                              void action(
                                [
                                  {
                                    op: 'complete_task',
                                    task: `#${t.id}`,
                                    expectedVersion: t.version,
                                  },
                                ],
                                false,
                              )
                            }
                          >
                            {t.status === 'in_progress' && <span />}
                          </button>
                        )}
                        <button
                          className="task-title"
                          disabled={busy}
                          onClick={() => setModal({ type: 'task', task: t })}
                        >
                          <strong>{t.title}</strong>
                          <span>
                            {t.id < 0 ? 'Aguardando sincronização' : `#${t.id}`}
                            {t.checklist?.length ? (
                              <em>
                                {t.checklist.filter((i) => i.done).length}/{t.checklist.length}{' '}
                                etapas
                              </em>
                            ) : null}
                            {t.recurrence && <em>Recorrente</em>}
                            {t.tags?.map((tag) => (
                              <em className="task-tag" key={tag}>
                                {tag}
                              </em>
                            ))}
                            {t.status === 'in_progress' && <em>Em andamento</em>}
                            {t.trashedAt && (
                              <em>{t.trashReason === 'completed' ? 'Concluída' : 'Descartada'}</em>
                            )}
                            {t.description && (
                              <span className="description-preview">{t.description}</span>
                            )}
                          </span>
                        </button>
                      </div>
                      <span className="task-group">
                        <span
                          className={`group-dot color-${
                            Math.max(
                              0,
                              groups.findIndex((g) => g.id === t.groupId),
                            ) % 5
                          }`}
                        />
                        {groups.find((g) => g.id === t.groupId)?.name ?? 'Caixa de entrada'}
                      </span>
                      <span
                        className={`task-due ${!isTrash && overdue(t) ? 'late' : ''} ${t.dueDate === today() && !isTrash ? 'due-today' : ''}`}
                      >
                        {isTrash ? (
                          timestamp(t.purgeAt!)
                        ) : (
                          <>
                            <Clock3 size={13} />
                            {due(t)}
                          </>
                        )}
                      </span>
                      <span className={`priority priority-${t.priority}`}>
                        <i />
                        {priorityLabels[t.priority]}
                      </span>
                      {isTrash || view === 'completed' ? (
                        <button
                          className="icon-button"
                          title="Restaurar"
                          aria-label={`Restaurar ${t.title}`}
                          disabled={busy}
                          onClick={() =>
                            void action(
                              [
                                {
                                  op: 'restore_task',
                                  task: `#${t.id}`,
                                  expectedVersion: t.version,
                                },
                              ],
                              false,
                            )
                          }
                        >
                          <RotateCcw size={17} />
                        </button>
                      ) : (
                        <button
                          className="icon-button"
                          aria-label={`Editar ${t.title}`}
                          disabled={busy}
                          onClick={() => setModal({ type: 'task', task: t })}
                        >
                          <MoreHorizontal size={19} />
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <span className="empty-icon">
                      {isTrash ? (
                        <CheckCheck size={31} />
                      ) : search || priority || status ? (
                        <Search size={30} />
                      ) : (
                        <Inbox size={31} />
                      )}
                    </span>
                    <h3>
                      {search || priority || status
                        ? 'Nenhuma tarefa por aqui'
                        : isTrash
                          ? 'Tudo em seu lugar'
                          : view === 'today'
                            ? 'Seu dia está em aberto'
                            : view === 'overdue'
                              ? 'Nenhuma tarefa atrasada'
                              : 'Abra espaço para o próximo passo'}
                    </h3>
                    <p>
                      {search || priority || status
                        ? 'Tente outra busca ou ajuste os filtros.'
                        : isTrash
                          ? 'Tarefas descartadas aparecerão aqui.'
                          : 'Anote uma tarefa pequena. O resto vem no seu ritmo.'}
                    </p>
                    {!isTrash && (
                      <button
                        className="button secondary"
                        onClick={() => setModal({ type: 'task' })}
                      >
                        <Plus size={16} />
                        Adicionar tarefa
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="list-footer">
                <span>
                  {filtered.length
                    ? `${(currentPage - 1) * 20 + 1}–${Math.min(currentPage * 20, filtered.length)} de ${filtered.length} tarefas`
                    : 'Nenhuma tarefa nesta visualização'}
                </span>
                <div className="pagination">
                  <button
                    className="icon-button tiny"
                    aria-label="Página anterior"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    <ArrowLeft size={15} />
                  </button>
                  <span>
                    {currentPage} / {pages}
                  </span>
                  <button
                    className="icon-button tiny"
                    aria-label="Próxima página"
                    disabled={currentPage >= pages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            </section>
          )}
          {view !== 'assistant' && (
            <section className="conversation-banner">
              <span className="banner-icon">
                <MessageCircle size={25} />
              </span>
              <div>
                <h3>Uma conversa também organiza.</h3>
                <p>Crie e consulte tarefas por mensagem, no notebook ou no celular.</p>
              </div>
              <button className="button secondary" onClick={() => navigate('assistant')}>
                Abrir assistente
                <ArrowRight size={16} />
              </button>
            </section>
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-dot" />
              Seu espaço, no seu ritmo.
            </span>
            <button className="text-button" onClick={() => setModal({ type: 'activity' })}>
              Atividade{issueCount > 0 && <span className="count-pill">{issueCount}</span>}
              <ChevronRight size={14} />
            </button>
          </footer>
        </main>
      </div>
      {notice && (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          <span>{notice.error ? <Circle size={18} /> : <Check size={18} />}</span>
          <p>{notice.text}</p>
          <button
            className="icon-button tiny"
            aria-label="Dispensar aviso"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal?.type === 'task' && (
        <TaskDialog
          task={modal.task}
          groups={groups}
          defaultGroup={group?.id}
          history={(data?.history ?? []).filter((h) => h.taskId === modal.task?.id)}
          busy={busy}
          close={() => setModal(null)}
          action={action}
        />
      )}
      {modal?.type === 'group' && (
        <GroupDialog
          taskCount={
            // As da lixeira não entram: a exclusão do grupo não mexe nelas, e contá-las aqui
            // prometeria uma escolha sobre tarefas que vão ficar exatamente como estão.
            tasks.filter((t) => t.groupId === modal.group?.id && !t.trashedAt).length
          }
          group={modal.group}
          busy={busy}
          close={() => setModal(null)}
          action={action}
        />
      )}
      {modal?.type === 'settings' && (
        <SettingsDialog
          data={data}
          busy={busy}
          close={() => setModal(null)}
          action={action}
          openLlm={() => setModal({ type: 'llm' })}
          openSecurity={() => setModal({ type: 'security' })}
          openBackup={() => setModal({ type: 'backup' })}
        />
      )}
      {modal?.type === 'security' && <SecurityDialog close={() => setModal(null)} />}
      {modal?.type === 'backup' && data && (
        <BackupDialog data={data} close={() => setModal(null)} refresh={refresh} />
      )}
      {modal?.type === 'llm' && (
        <Dialog
          title="Modelos de IA"
          subtitle="Cadastre suas APIs e escolha a ordem de uso."
          close={() => setModal(null)}
          wide
        >
          <LlmSettings onChange={refresh} />
        </Dialog>
      )}
      {modal?.type === 'activity' && (
        <ActivityDialog data={data} close={() => setModal(null)} refresh={refresh} />
      )}
    </div>
  );
}
