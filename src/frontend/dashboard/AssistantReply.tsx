'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ListTodo } from 'lucide-react';

type Line =
  | { kind: 'task'; id: string; title: string; detail: string }
  | { kind: 'option'; number: string; label: string }
  | { kind: 'summary' | 'text'; text: string };

// Custo de cada linha em passos da digitação: texto anda palavra por palavra, cartões de
// tarefa e opções entram inteiros.
const CARD = 4;
// Respiro entre um balão e o próximo, com os três pontinhos na tela.
const PAUSE = 10;
const TICK_MS = 24;
// Respostas longas aceleram: a digitação inteira nunca passa de uns dois segundos.
const MAX_TICKS = 85;

const words = (text: string) => text.match(/\S+\s*/g) ?? [];
const cost = (line: Line) =>
  line.kind === 'task' || line.kind === 'option' ? CARD : Math.max(1, words(line.text).length);

function parse(text: string, options: boolean): Line[][] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) =>
      block.split('\n').map((line): Line => {
        const task = line.match(/^#(\d+) (.+) — (.+)$/);
        if (task) return { kind: 'task', id: task[1], title: task[2], detail: task[3] };
        const option = options && line.match(/^(\d+)\. (.+)$/);
        if (option) return { kind: 'option', number: option[1], label: option[2] };
        if (/^\d+ tarefa\(s\)/.test(line)) return { kind: 'summary', text: line };
        return { kind: 'text', text: line };
      }),
    );
}

function reducedMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function TypingBubble({ label }: { label: string }) {
  return (
    <div className="bubble assistant typing" role="status" aria-live="polite">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  );
}

// Uma resposta do assistente, dividida em balões (um por parágrafo). Quando `animate` está
// ligado, os balões aparecem um de cada vez e o texto é escrito aos poucos, como numa conversa;
// respostas antigas, recarregadas da lista, aparecem inteiras.
export function AssistantTurn({
  text,
  animate = false,
  onPick,
  onProgress,
  onDone,
}: {
  text: string;
  animate?: boolean;
  onPick?: (answer: string) => void;
  onProgress?: () => void;
  onDone?: () => void;
}) {
  const sections = useMemo(() => parse(text, Boolean(onPick)), [text, onPick]);
  const total = useMemo(
    () =>
      sections.reduce((sum, lines) => sum + lines.reduce((s, l) => s + cost(l), 0), 0) +
      PAUSE * Math.max(0, sections.length - 1),
    [sections],
  );
  const [shown, setShown] = useState(() => (animate && !reducedMotion() ? 0 : Infinity));
  const finished = useRef(false);
  useEffect(() => {
    if (shown === Infinity) return;
    const step = Math.max(1, Math.ceil(total / MAX_TICKS));
    const timer = setInterval(
      () => setShown((current) => (current + step >= total ? Infinity : current + step)),
      TICK_MS,
    );
    return () => clearInterval(timer);
    // O intervalo começa uma vez e para ao terminar; mudar o texto no meio só muda o que
    // falta mostrar.
  }, [total, shown === Infinity]);
  useEffect(() => {
    onProgress?.();
    if (shown === Infinity && !finished.current) {
      finished.current = true;
      onDone?.();
    }
  }, [shown, onProgress, onDone]);

  let budget = shown;
  const bubbles: ReactNode[] = [];
  for (const [index, lines] of sections.entries()) {
    if (index > 0) {
      if (budget <= PAUSE) {
        bubbles.push(<TypingBubble key="typing" label="Escrevendo" />);
        break;
      }
      budget -= PAUSE;
    }
    if (budget <= 0) break;
    const rendered: ReactNode[] = [];
    for (const [i, line] of lines.entries()) {
      if (budget <= 0) break;
      const size = cost(line);
      if (line.kind === 'task')
        rendered.push(
          <div className="reply-task" key={i}>
            <span className="reply-task-id">#{line.id}</span>
            <div>
              <strong>{line.title}</strong>
              <small>{line.detail}</small>
            </div>
          </div>,
        );
      else if (line.kind === 'option')
        rendered.push(
          <button
            type="button"
            className="reply-option"
            key={i}
            onClick={() => onPick?.(line.number)}
          >
            <span>{line.number}</span>
            {line.label}
          </button>,
        );
      else {
        const visible = budget >= size ? line.text : words(line.text).slice(0, budget).join('');
        rendered.push(
          <p className={line.kind === 'summary' ? 'reply-summary' : undefined} key={i}>
            {visible}
          </p>,
        );
      }
      budget -= size;
    }
    bubbles.push(
      <div className={`bubble assistant${index > 0 ? ' follow-up' : ''}`} key={index}>
        {index === 0 && (
          <span className="assistant-name">
            <ListTodo size={14} />
            AgendaMagna
          </span>
        )}
        <div className="assistant-reply">
          <section>{rendered}</section>
        </div>
      </div>,
    );
  }
  return <div className="assistant-turn">{bubbles}</div>;
}
