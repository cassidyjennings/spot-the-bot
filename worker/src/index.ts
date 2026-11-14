// Worker entry: lists sections and routes each WebSocket to its section's Durable Object.
export { GameRoom } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace;
  SESSIONS: { id: string; name: string }[];
  SESSION_PASSWORDS: string; // secret, JSON: {"s1":"pw", ...}
  INSTRUCTOR_PASSWORD: string; // secret
  ALLOWED_ORIGINS?: string; // comma-separated; empty = allow all
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_MODE?: string;
  LLM_API_KEY?: string; // secret
}

function cors(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = !allowed.length || (origin && allowed.includes(origin));
  return ok ? { 'access-control-allow-origin': origin ?? '*', vary: 'origin' } : {};
}

function originAllowed(env: Env, origin: string | null) {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allowed.length || (origin !== null && allowed.includes(origin));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    if (url.pathname === '/sessions') {
      return Response.json(env.SESSIONS.map(({ id, name }) => ({ id, name })), { headers: cors(env, origin) });
    }
    if (url.pathname === '/health') return new Response('ok');

    if (url.pathname === '/ws') {
      if (!originAllowed(env, origin)) return new Response('Forbidden origin', { status: 403 });
      const id = url.searchParams.get('session') ?? '';
      const session = env.SESSIONS.find((s) => s.id === id);
      if (!session) return new Response('Unknown session', { status: 404 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(session.id));
      const fwd = new URL(request.url);
      fwd.searchParams.set('name', session.name);
      return stub.fetch(new Request(fwd.toString(), request));
    }
    return new Response('Not found', { status: 404 });
  },
};
