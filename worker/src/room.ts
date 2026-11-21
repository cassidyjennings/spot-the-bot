// One Durable Object per section: authoritative game state, sockets, timers, persistence.
// All game rules live in shared/engine.ts; this file is I/O glue.
import { DurableObject } from 'cloudflare:workers';
import { Engine, type Actor, type LlmRequest, type ModerationRequest } from '../../shared/engine';
import { newRoomState, type ClientMsg, type RoomState, type ServerMsg } from '../../shared/types';
import { displayView, groupView, instructorView } from '../../shared/views';
import persona from '../prompts/persona.md';
import { answerWithRetry, LlmQueue, moderateWithRetry } from './llm';
import type { Env } from './index';

interface Attachment {
  role: 'group' | 'instructor' | 'display';
  id: string;
  token: string;
}

const STATE_KEY = 'state';
const SLIDER_SAVE_MS = 2000;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class GameRoom extends DurableObject<Env> {
  private engine: Engine | null = null;
  private inflight = new Set<string>();
  private lastSliderSave = 0;
  // Shared by answer calls and safety checks. At ~1.5 s per Gemini call, 8 in flight is ~320 calls/min
  // per section, well above the ~60 calls/min that 40 groups produce.
  private queue = new LlmQueue(8, (queued) => {
    if (!this.engine) return;
    const was = this.engine.s.llm.queued;
    this.engine.s.llm.queued = queued;
    if ((was > 3) !== (queued > 3)) this.commit();
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get<RoomState>(STATE_KEY);
      if (s) this.load(s);
    });
  }

  private load(s: RoomState) {
    this.engine = new Engine(s, {
      now: () => Date.now(),
      rng: Math.random,
      id: () => crypto.randomUUID().slice(0, 8),
      token: randomToken,
      requestLlm: (r) => this.runLlm(r),
      requestModeration: (r) => this.runModeration(r),
    });
    // After an eviction/restart, any question still waiting on the LLM or the safety check lost its request.
    for (const r of this.engine.pendingLlm()) this.runLlm(r);
    for (const r of this.engine.pendingModeration()) this.runModeration(r);
  }

  private setLimited = (limited: boolean) => {
    if (this.engine && this.engine.s.llm.rateLimited !== limited) {
      this.engine.s.llm.rateLimited = limited;
      this.commit();
    }
  };

  private runModeration(req: ModerationRequest) {
    const key = `mod:${req.exchangeId}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    this.queue
      .run(() => moderateWithRetry(this.env, req, this.setLimited))
      .then((result) => {
        this.inflight.delete(key);
        this.engine?.moderationResult(req.exchangeId, result);
        this.commit();
      });
  }

  private runLlm(req: LlmRequest) {
    if (this.inflight.has(req.exchangeId)) return;
    this.inflight.add(req.exchangeId);
    const setLimited = this.setLimited;
    this.queue
      .run(() => answerWithRetry(this.env, persona, req, setLimited))
      .then((result) => {
        this.inflight.delete(req.exchangeId);
        this.engine?.llmResult(req.exchangeId, result);
        this.commit();
      });
  }

  // ---------- HTTP / WebSocket entry ----------

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handleFetch(request);
    } catch (err: any) {
      console.error('GameRoom.fetch failed', err?.stack ?? err);
      return new Response('Room error', { status: 500 });
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('session')!;
    const name = url.searchParams.get('name') ?? sessionId;
    if (!this.engine) {
      this.load(newRoomState(sessionId, name));
      await this.save();
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const e = this.engine!;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment | null;

    if (!att) return this.authenticate(ws, msg);

    if (msg.t === 'ping') {
      const who = att.role === 'group' ? e.s.groups.find((g) => g.id === att.id) : e.s.instructors.find((i) => i.id === att.id);
      if (who) {
        who.lastSeen = Date.now();
        who.connected = true;
      }
      if (att.role !== 'group') this.sendView(ws, att); // instructors refresh heartbeat ages
      return;
    }
    if (att.role === 'display') return;

    if (msg.t === 'session:delete') {
      if (att.role !== 'instructor') return;
      await this.ctx.storage.deleteAll();
      e.reset(false);
      this.commit();
      return;
    }

    const actor: Actor = { role: att.role, id: att.id };
    const err = e.handle(actor, msg);
    if (err) this.send(ws, { t: 'error', msg: err });
    if ((msg.t === 'guess:update' || msg.t === 'iguess:update') && !err) this.commitSlider(att);
    else this.commit();
  }

  private authenticate(ws: WebSocket, msg: ClientMsg) {
    const e = this.engine!;
    const sid = e.s.sessionId;
    let att: Attachment | null = null;

    if (msg.t === 'group:join') {
      let passwords: Record<string, string> = {};
      try {
        passwords = JSON.parse(this.env.SESSION_PASSWORDS || '{}');
      } catch {}
      const expected = passwords[sid];
      if (!expected || !safeEqual(String(msg.password ?? '').trim(), expected)) {
        return this.send(ws, { t: 'error', msg: 'Wrong session password.' });
      }
      const r = e.joinGroup(msg.name);
      if ('error' in r) return this.send(ws, { t: 'error', msg: r.error });
      att = { role: 'group', id: r.group.id, token: r.group.token };
    } else if (msg.t === 'group:rejoin') {
      const g = e.groupByToken(String(msg.token));
      if (!g) return this.send(ws, { t: 'error', msg: 'Please join again.', fatal: true });
      att = { role: 'group', id: g.id, token: g.token };
    } else if (msg.t === 'instructor:login') {
      if (!this.env.INSTRUCTOR_PASSWORD || !safeEqual(String(msg.password ?? ''), this.env.INSTRUCTOR_PASSWORD)) {
        return this.send(ws, { t: 'error', msg: 'Wrong instructor password.' });
      }
      const i = e.loginInstructor(msg.name);
      att = { role: 'instructor', id: i.id, token: i.token };
    } else if (msg.t === 'instructor:rejoin' || msg.t === 'display:rejoin') {
      const i = e.instructorByToken(String(msg.token));
      if (!i) return this.send(ws, { t: 'error', msg: 'Please log in again.', fatal: true });
      att = { role: msg.t === 'display:rejoin' ? 'display' : 'instructor', id: i.id, token: i.token };
    } else {
      return this.send(ws, { t: 'error', msg: 'Not logged in.', fatal: true });
    }

    ws.serializeAttachment(att);
    if (att.role !== 'display') e.setConnected({ role: att.role, id: att.id }, true);
    this.send(ws, { t: 'auth', role: att.role, token: att.token, id: att.id });
    this.commit();
  }

  async webSocketClose(ws: WebSocket) {
    this.onGone(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.onGone(ws);
  }

  private onGone(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.role === 'display' || !this.engine) return;
    const others = this.ctx.getWebSockets().filter((s) => {
      if (s === ws || s.readyState !== WebSocket.OPEN) return false;
      const a = s.deserializeAttachment() as Attachment | null;
      return a?.role === att.role && a.id === att.id;
    });
    if (!others.length) {
      this.engine.setConnected({ role: att.role, id: att.id }, false);
      this.commit();
    }
  }

  async alarm() {
    if (!this.engine) return;
    if (this.engine.shouldPurge()) {
      await this.ctx.storage.deleteAll();
      this.engine.reset(false);
    } else {
      this.engine.tick();
    }
    this.commit();
  }

  // ---------- persistence + broadcast ----------

  private save() {
    return this.ctx.storage.put(STATE_KEY, this.engine!.s);
  }

  private commit() {
    if (!this.engine) return;
    this.engine.tick();
    this.save();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att) this.sendView(ws, att);
    }
    const wake = this.engine.nextWakeAt();
    if (wake) this.ctx.storage.setAlarm(wake);
    else this.ctx.storage.deleteAlarm();
  }

  /**
   * Slider drags arrive up to 4 times a second per student. Only the dragging group and the instructors
   * can see the slider (responders and the projector never get it), so send just those views instead of
   * rebuilding one for every phone, and write the state at most every SLIDER_SAVE_MS.
   * Falls back to a full commit if the clock tick moved the game on.
   */
  private commitSlider(from: Attachment) {
    const e = this.engine!;
    const before = `${e.s.phase}/${e.s.round}/${e.s.pausedRemaining === null}`;
    e.tick();
    if (before !== `${e.s.phase}/${e.s.round}/${e.s.pausedRemaining === null}`) return this.commit();
    const now = Date.now();
    if (now - this.lastSliderSave > SLIDER_SAVE_MS) {
      this.lastSliderSave = now;
      this.save();
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && (att.role === 'instructor' || (att.role === 'group' && att.id === from.id))) this.sendView(ws, att);
    }
  }

  private sendView(ws: WebSocket, att: Attachment) {
    const s = this.engine!.s;
    const now = Date.now();
    if (att.role === 'group') {
      const g = s.groups.find((x) => x.id === att.id);
      if (!g || g.token !== att.token || g.removed || g.released) return this.kick(ws, 'Your group was signed out by an instructor.');
      return this.send(ws, { t: 'snapshot', view: groupView(s, g.id, now) });
    }
    const i = s.instructors.find((x) => x.id === att.id);
    if (!i || i.token !== att.token) return this.kick(ws, 'Please log in again.');
    this.send(ws, { t: 'snapshot', view: att.role === 'display' ? displayView(s, now) : instructorView(s, i.id, now) });
  }

  private kick(ws: WebSocket, msg: string) {
    this.send(ws, { t: 'error', msg, fatal: true });
    try {
      ws.close(4000, 'signed out');
    } catch {}
  }

  private send(ws: WebSocket, m: ServerMsg) {
    try {
      ws.send(JSON.stringify(m));
    } catch {}
  }
}
