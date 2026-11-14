// WebSocket connection with auto-reconnect, heartbeat and server-clock offset.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClientMsg, ServerMsg } from '../../shared/types';

export const WORKER_URL = (
  import.meta.env.VITE_WORKER_URL || `http://${location.hostname || '127.0.0.1'}:8787`
).replace(/\/$/, '');
const WS_URL = WORKER_URL.replace(/^http/, 'ws');

export interface Section {
  id: string;
  name: string;
}

export async function fetchSections(): Promise<Section[]> {
  const r = await fetch(`${WORKER_URL}/sessions`);
  if (!r.ok) throw new Error('Could not reach the game server.');
  return r.json();
}

// ---- tiny storage helpers (storage can throw in private mode) ----
export function load<T>(key: string, store: Storage = localStorage): T | null {
  try {
    const v = store.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
export function save(key: string, value: unknown, store: Storage = localStorage) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {}
}

export interface Room<V> {
  view: V | null;
  connected: boolean;
  authed: boolean;
  error: string | null;
  /** serverNow - Date.now() at the last snapshot; add to Date.now() for server time. */
  offset: number;
  send(m: ClientMsg): void;
}

/**
 * Connects to a section's room. `authMsg()` is called on every (re)connect.
 * `onAuth` receives the token; `onReject` fires on a fatal error or a rejected first login,
 * after which the hook stops reconnecting.
 */
export function useRoom<V>(
  sessionId: string | null,
  authMsg: () => ClientMsg | null,
  onAuth: (token: string) => void,
  onReject: (msg: string) => void,
): Room<V> {
  const [view, setView] = useState<V | null>(null);
  const [connected, setConnected] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const cb = useRef({ authMsg, onAuth, onReject });
  cb.current = { authMsg, onAuth, onReject };

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let retry = 0;
    let errTimer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let isAuthed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      const ws = new WebSocket(`${WS_URL}/ws?session=${encodeURIComponent(sessionId)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        const m = cb.current.authMsg();
        if (m) ws.send(JSON.stringify(m));
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 15_000);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        if (m.t === 'auth') {
          isAuthed = true;
          setAuthed(true);
          cb.current.onAuth(m.token);
        } else if (m.t === 'snapshot') {
          const v = m.view as V & { serverNow: number };
          setOffset(v.serverNow - Date.now());
          setView(v);
        } else if (m.t === 'error') {
          if (m.fatal || !isAuthed) {
            stopped = true;
            ws.close();
            cb.current.onReject(m.msg);
            return;
          }
          setError(m.msg);
          clearTimeout(errTimer);
          errTimer = setTimeout(() => setError(null), 4000);
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        setConnected(false);
        isAuthed = false;
        setAuthed(false);
        if (!stopped) reconnect = setTimeout(open, Math.min(5000, 500 * 2 ** retry++));
      };
    };
    open();
    // Phones drop sockets when locked; reconnect fast when the page is visible again.
    const onVis = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState === WebSocket.CLOSED && !stopped) {
        clearTimeout(reconnect);
        open();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(ping);
      wsRef.current?.close();
      setView(null);
      setAuthed(false);
    };
  }, [sessionId]);

  return {
    view,
    connected,
    authed,
    error,
    offset,
    send: (m) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      else setError('Reconnecting… try again in a moment.');
    },
  };
}
