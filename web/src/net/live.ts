/** A WebSocket to a live pit-wall server. It only listens. Nothing is ever sent to it. */

import { type Message, parseFrame } from '../core/messages';

export type LiveEvent =
  | { kind: 'open' }
  | { kind: 'message'; message: Message; dropped: number }
  | { kind: 'dropped'; dropped: number }
  | { kind: 'closed'; clean: boolean; sawEnd: boolean }
  | { kind: 'error' };

/** Accept ws: and wss: addresses only. Anything else is refused before a socket is opened. */
export function parseSocketUrl(text: string | null): URL | null {
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? url : null;
  } catch {
    return null;
  }
}

export function connect(url: URL, on: (event: LiveEvent) => void): () => void {
  const socket = new WebSocket(url);
  let sawEnd = false;
  socket.addEventListener('open', () => on({ kind: 'open' }));
  socket.addEventListener('error', () => on({ kind: 'error' }));
  socket.addEventListener('close', (e) => on({ kind: 'closed', clean: e.wasClean, sawEnd }));
  socket.addEventListener('message', (e) => {
    const parsed = parseFrame(e.data);
    if (parsed.message) {
      if (parsed.message.type === 'end') sawEnd = true;
      on({ kind: 'message', message: parsed.message, dropped: parsed.dropped });
    } else {
      on({ kind: 'dropped', dropped: parsed.dropped });
    }
  });
  return () => socket.close();
}
