import type { KeyboardEvent } from 'react';

// Tecla que envia a mensagem do chat. Preferência do aparelho, como o tema: no notebook faz
// sentido Enter quebrar a linha, no celular o teclado virtual nem tem Ctrl.
export type SendKey = 'ctrl-enter' | 'enter';

const SEND_KEY = 'agenda:send-key';
export const SEND_KEY_EVENT = 'agenda:send-key';

export function readSendKey(): SendKey {
  try {
    return localStorage.getItem(SEND_KEY) === 'enter' ? 'enter' : 'ctrl-enter';
  } catch {
    return 'ctrl-enter';
  }
}
export function saveSendKey(key: SendKey) {
  try {
    localStorage.setItem(SEND_KEY, key);
  } catch {
    // A escolha vale para esta sessão mesmo sem conseguir guardar.
  }
  // O chat pode estar aberto por trás da janela de configurações.
  window.dispatchEvent(new Event(SEND_KEY_EVENT));
}
// Ctrl+Enter (⌘+Enter no Mac) envia nos dois modos. Enter sozinho só envia no modo 'enter', em
// que Shift+Enter quebra a linha. Durante a composição de acentos o Enter pertence ao teclado.
export function sendsMessage(key: SendKey, e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return false;
  return e.ctrlKey || e.metaKey || (key === 'enter' && !e.shiftKey && !e.altKey);
}
