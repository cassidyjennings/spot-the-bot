// Pure game engine: all rules live here so they can be unit-tested without a server.
// The Durable Object (worker/src/room.ts) owns I/O: sockets, storage, alarms, LLM calls.
import { planRound1, planRound2, type MatchPlan } from './matching';
import { cleanText, validateGroupName } from './moderation';
import { exchangesOf } from './scoring';
import { isActive, presentGroups, revealAtWhenQuiet } from './views';
import {
  LOCKIN_MS,
  MAX_ANSWER,
  MAX_QUESTION,
  STALE_MS,
  newRoomState,
  type ClientMsg,
  type Exchange,
  type Group,
  type Instructor,
  type Match,
  type Round,
  type RoomState,
} from './types';

export type Actor = { role: 'group'; id: string } | { role: 'instructor'; id: string };

export type LlmResult =
  | { kind: 'ok'; text: string }
  | { kind: 'decline' }
  | { kind: 'error'; msg: string };

export interface LlmRequest {
  exchangeId: string;
  history: { q: string; a: string }[];
  question: string;
}

export type ModerationResult =
  | { kind: 'ok' }
  | { kind: 'flag' }
  | { kind: 'error'; msg: string };

export interface ModerationRequest {
  exchangeId: string;
  question: string;
  text: string;
}

export interface EngineDeps {
  now(): number;
  rng(): number;
  id(): string;
  token(): string;
  requestLlm(req: LlmRequest): void;
  /** Safety-check a student's answer. The result comes back through moderationResult(). */
  requestModeration(req: ModerationRequest): void;
}

/** Wait this long after the last answer arrives (post-timer) so the slider can be set. */
export const SLIDER_SETTLE_MS = LOCKIN_MS;
export const RETENTION_MS = 7 * 24 * 3600_000;
/** A student answer may be flagged this many times before the question is voided. */
export const MAX_ANSWER_FLAGS = 3;

type Result = string | void; // string = error message for the sender

export class Engine {
  constructor(public s: RoomState, private d: EngineDeps) {}

  // ---------- auth ----------

  joinGroup(rawName: string): { group: Group } | { error: string } {
    const name = cleanText(rawName, 40);
    const err = validateGroupName(name);
    if (err) return { error: err };
    if (this.s.phase === 'ended') return { error: 'This game has ended.' };
    const existing = presentGroups(this.s).find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!existing.released) return { error: 'That group name is taken. Pick another.' };
      existing.released = false;
      existing.token = this.d.token();
      return { group: existing };
    }
    const g: Group = {
      id: this.d.id(),
      name,
      token: this.d.token(),
      connected: true,
      lastSeen: this.d.now(),
      joinedAt: this.d.now(),
      released: false,
      removed: false,
    };
    this.s.groups.push(g);
    return { group: g };
  }

  groupByToken(token: string): Group | undefined {
    return this.s.groups.find((g) => g.token === token && !g.removed && !g.released);
  }

  loginInstructor(rawName: string): Instructor {
    const name = cleanText(rawName, 30) || 'Instructor';
    const i: Instructor = { id: this.d.id(), name, token: this.d.token(), connected: true, lastSeen: this.d.now() };
    this.s.instructors.push(i);
    return i;
  }

  instructorByToken(token: string): Instructor | undefined {
    return this.s.instructors.find((i) => i.token === token);
  }

  setConnected(actor: Actor, connected: boolean) {
    const who = actor.role === 'group' ? this.s.groups.find((g) => g.id === actor.id) : this.s.instructors.find((i) => i.id === actor.id);
    if (who) {
      who.connected = connected;
      who.lastSeen = this.d.now();
    }
  }

  // ---------- helpers ----------

  private now() {
    return this.d.now();
  }

  currentMatches(): Match[] {
    return this.s.matches.filter((m) => m.round === this.s.round);
  }

  private exchange(id: string) {
    return this.s.exchanges.find((e) => e.id === id);
  }

  private matchOf(e: Exchange) {
    return this.s.matches.find((m) => m.id === e.matchId)!;
  }

  timerEnded(): boolean {
    return (
      isActive(this.s.phase) &&
      this.s.pausedRemaining === null &&
      this.s.roundEndsAt !== null &&
      this.now() >= this.s.roundEndsAt
    );
  }

  private addMatches(plans: MatchPlan[]) {
    for (const p of plans) this.s.matches.push({ id: this.d.id(), ...p });
  }

  private instructorPools() {
    const all = this.s.instructors.map((i) => i.id);
    const connected = this.s.instructors.filter((i) => i.connected).map((i) => i.id);
    return { all, connected };
  }

  alert(text: string) {
    this.s.alerts.unshift({ id: this.d.id(), at: this.now(), text });
    this.s.alerts = this.s.alerts.slice(0, 20);
  }

  // ---------- message dispatch ----------

  handle(actor: Actor, msg: ClientMsg): Result {
    if (actor.role === 'group') {
      switch (msg.t) {
        case 'question:submit':
          return this.submitQuestion(actor.id, msg.text);
        case 'answer:submit':
          return this.submitAnswer(actor, msg.exchangeId, msg.text);
        case 'guess:update':
          return this.updateGuess(actor, msg.exchangeId, msg.v);
        case 'group:leave': {
          // Same effect as an instructor's "Release name": the name frees up and the group can rejoin.
          const g = this.s.groups.find((x) => x.id === actor.id);
          if (!g) return 'No such group.';
          g.released = true;
          g.connected = false;
          g.token = this.d.token();
          return;
        }
        default:
          return 'Not allowed.';
      }
    }
    const me = actor.id;
    switch (msg.t) {
      case 'answer:submit':
        return this.submitAnswer(actor, msg.exchangeId, msg.text);
      case 'config:set':
        return this.setConfig(msg.roundMinutes);
      case 'round:start':
        return this.startRound();
      case 'round:end':
        return this.endRoundEarly();
      case 'round:reveal':
        return this.forceReveal();
      case 'timer:adjust':
        return this.adjustTimer(msg.deltaMs);
      case 'timer:pause':
        return this.pause();
      case 'timer:resume':
        return this.resume();
      case 'game:end':
        if (this.s.phase === 'lobby') return 'Game has not started.';
        if (isActive(this.s.phase)) this.reveal();
        this.s.phase = 'ended';
        this.s.endedAt = this.now();
        return;
      case 'session:reset':
        this.reset(true);
        return;
      case 'exchange:block':
        return this.block(msg.exchangeId, me);
      case 'match:takeover':
      case 'match:untakeover': {
        const m = this.s.matches.find((x) => x.id === msg.matchId);
        if (!m || m.responderType !== 'group') return 'No such group match.';
        if (m.interrogatorType === 'instructor') return 'An instructor is already asking in this match.';
        m.takenOverBy = msg.t === 'match:takeover' ? me : undefined;
        return;
      }
      case 'match:claim': {
        const m = this.s.matches.find((x) => x.id === msg.matchId);
        if (!m || (m.responderType !== 'instructor' && m.interrogatorType !== 'instructor')) return 'No such instructor match.';
        m.instructorId = me;
        return;
      }
      case 'iq:submit':
        return this.submitInstructorQuestion(me, msg.matchId, msg.text);
      case 'iguess:update':
        return this.updateGuess(actor, msg.exchangeId, msg.v);
      case 'late:match':
        return this.matchLateJoiner(msg.groupId, me);
      case 'group:release': {
        const g = this.s.groups.find((x) => x.id === msg.groupId);
        if (!g) return 'No such group.';
        g.released = true;
        g.connected = false;
        g.token = this.d.token();
        return;
      }
      case 'group:remove': {
        const g = this.s.groups.find((x) => x.id === msg.groupId);
        if (!g) return 'No such group.';
        g.removed = true;
        g.connected = false;
        g.token = this.d.token();
        return;
      }
      case 'alerts:clear':
        this.s.alerts = [];
        return;
      default:
        return 'Unknown command.';
    }
  }

  /** Back to lobby. keepGroups=false wipes everyone (used by "delete session data"). */
  reset(keepInstructors: boolean) {
    const fresh = newRoomState(this.s.sessionId, this.s.sectionName);
    fresh.config = this.s.config;
    if (keepInstructors) fresh.instructors = this.s.instructors;
    this.s = fresh;
  }

  // ---------- lobby / rounds ----------

  private setConfig(minutes: number): Result {
    if (isActive(this.s.phase)) return 'Change the round length between rounds.';
    const m = Number(minutes);
    if (!(m >= 0.25 && m <= 30)) return 'Round length must be 0.25-30 minutes.';
    this.s.config.roundMs = Math.round(m * 60_000);
  }

  private startRound(): Result {
    let round: Round;
    if (this.s.phase === 'lobby') round = 1;
    else if (this.s.phase === 'round1_reveal') round = 2;
    else return 'A round can start only from the lobby or after the Round 1 reveal.';

    const now = this.now();
    const live = presentGroups(this.s).filter((g) => g.connected || now - g.lastSeen < STALE_MS);
    if (round === 1) {
      if (!live.length) return 'No groups have joined yet.';
      this.addMatches(planRound1(live.map((g) => g.id), this.instructorPools(), this.d.rng));
    } else {
      const present = presentGroups(this.s).map((g) => g.id);
      if (!present.length) return 'No groups.';
      const r1 = this.s.matches.filter((m) => m.round === 1 && !m.late);
      this.addMatches(planRound2(r1, present, this.instructorPools(), this.d.rng));
    }
    this.s.round = round;
    this.s.phase = round === 1 ? 'round1_active' : 'round2_active';
    this.s.roundEndsAt = now + this.s.config.roundMs;
    this.s.pausedRemaining = null;
    this.s.graceEndsAt = null;
  }

  private matchLateJoiner(groupId: string, instructorId: string): Result {
    if (!isActive(this.s.phase)) return 'Late joiners can be matched only during a round.';
    const g = presentGroups(this.s).find((x) => x.id === groupId);
    if (!g) return 'No such group.';
    const busy = this.currentMatches().some((m) => m.interrogatorId === groupId || m.responderGroupId === groupId);
    if (busy) return 'That group is already playing.';
    this.s.matches.push({
      id: this.d.id(),
      round: this.s.round as Round,
      interrogatorId: groupId,
      responderType: 'instructor',
      instructorId,
      oddGroup: false,
      late: true,
    });
  }

  private endRoundEarly(): Result {
    if (!isActive(this.s.phase)) return 'No round is running.';
    this.s.roundEndsAt = this.now();
    this.s.pausedRemaining = null;
    this.tick();
  }

  private forceReveal(): Result {
    if (!isActive(this.s.phase)) return 'No round is running.';
    this.reveal();
  }

  private adjustTimer(deltaMs: number): Result {
    if (!isActive(this.s.phase)) return 'No round is running.';
    const d = Math.max(-10 * 60_000, Math.min(10 * 60_000, Number(deltaMs) || 0));
    const now = this.now();
    if (this.s.pausedRemaining !== null) {
      this.s.pausedRemaining = Math.max(0, this.s.pausedRemaining + d);
    } else if (this.timerEnded()) {
      if (d <= 0) return;
      this.s.roundEndsAt = now + d;
      this.s.graceEndsAt = null;
    } else {
      this.s.roundEndsAt = Math.max(now, this.s.roundEndsAt! + d);
    }
  }

  private pause(): Result {
    if (!isActive(this.s.phase) || this.s.pausedRemaining !== null) return 'Nothing to pause.';
    if (this.timerEnded()) return 'The timer has already ended.';
    this.s.pausedRemaining = this.s.roundEndsAt! - this.now();
  }

  private resume(): Result {
    if (this.s.pausedRemaining === null) return 'Not paused.';
    this.s.roundEndsAt = this.now() + this.s.pausedRemaining;
    this.s.pausedRemaining = null;
  }

  private reveal() {
    const r = this.s.round as Round;
    for (const m of this.currentMatches()) {
      for (const e of exchangesOf(this.s, m)) {
        if (e.state === 'pending') {
          e.state = 'void';
          e.voidReason = 'round ended';
          delete e.humanText;
          delete e.llmText;
        }
        if (e.state === 'released' && e.recordedGuess === null) e.recordedGuess = e.slider;
      }
    }
    this.s.phase = r === 1 ? 'round1_reveal' : 'round2_reveal';
    this.s.roundEndsAt = null;
    this.s.pausedRemaining = null;
    this.s.graceEndsAt = null;
  }

  /** Time-driven transitions. Returns true if state changed. */
  tick(): boolean {
    if (!isActive(this.s.phase) || !this.timerEnded()) return false;
    const now = this.now();
    let changed = false;
    if (this.s.graceEndsAt === null) {
      this.s.graceEndsAt = this.s.roundEndsAt! + this.s.config.graceMs;
      changed = true;
    }
    const exs = this.currentMatches().flatMap((m) => exchangesOf(this.s, m));
    const pending = exs.some((e) => e.state === 'pending');
    if (!pending) {
      const revealAt = revealAtWhenQuiet(this.s) ?? this.s.roundEndsAt!;
      if (now >= revealAt) {
        this.reveal();
        return true;
      }
    } else if (now >= this.s.graceEndsAt) {
      this.reveal();
      return true;
    }
    return changed;
  }

  /** When the server should next call tick() (or purge data). */
  nextWakeAt(): number | null {
    if (isActive(this.s.phase)) {
      if (this.s.pausedRemaining !== null) return null;
      if (!this.timerEnded()) return this.s.roundEndsAt;
      return this.now() + 1000;
    }
    if (this.s.phase === 'ended' && this.s.endedAt) return this.s.endedAt + RETENTION_MS;
    return null;
  }

  shouldPurge(): boolean {
    return this.s.phase === 'ended' && !!this.s.endedAt && this.now() >= this.s.endedAt + RETENTION_MS;
  }

  // ---------- exchange loop ----------

  private askGuard(): Result {
    if (!isActive(this.s.phase)) return 'No round is running.';
    if (this.s.pausedRemaining !== null) return 'The game is paused.';
    if (this.timerEnded()) return "Time's up! No new questions.";
  }

  private submitQuestion(groupId: string, raw: string): Result {
    const bad = this.askGuard();
    if (bad) return bad;
    const m = this.currentMatches().find((x) => x.interrogatorId === groupId);
    if (!m) return "You're not asking questions this round.";
    return this.askQuestion(m, raw);
  }

  /** An instructor types a question live in a match where an instructor asks (the odd group's answering turn). */
  private submitInstructorQuestion(instructorId: string, matchId: string, raw: string): Result {
    const bad = this.askGuard();
    if (bad) return bad;
    const m = this.currentMatches().find((x) => x.id === matchId && x.interrogatorType === 'instructor');
    if (!m) return "That isn't one of your question matches this round.";
    if (m.instructorId !== instructorId) return 'Claim this match first.';
    return this.askQuestion(m, raw);
  }

  private askQuestion(m: Match, raw: string): Result {
    const text = cleanText(raw, MAX_QUESTION);
    if (!text) return 'Type a question first.';
    const exs = exchangesOf(this.s, m);
    if (exs.some((e) => e.state === 'pending')) return 'Wait for both answers first.';

    // Lock in the slider for every earlier exchange.
    for (const e of exs) if (e.state === 'released' && e.recordedGuess === null) e.recordedGuess = e.slider;

    const ex: Exchange = {
      id: this.d.id(),
      matchId: m.id,
      idx: exs.length + 1,
      question: text,
      state: 'pending',
      slider: 0,
      recordedGuess: null,
      createdAt: this.now(),
    };
    this.s.exchanges.push(ex);
    this.d.requestLlm({
      exchangeId: ex.id,
      question: text,
      history: exs.filter((e) => e.state === 'released' && e.llmText).map((e) => ({ q: e.question, a: e.llmText! })),
    });
  }

  private submitAnswer(actor: Actor, exchangeId: string, raw: string): Result {
    const e = this.exchange(exchangeId);
    if (!e || e.state !== 'pending') return 'That question is no longer open.';
    if (e.humanText !== undefined) return 'Already answered.';
    const m = this.matchOf(e);
    if (m.round !== this.s.round || !isActive(this.s.phase)) return 'That round is over.';
    if (actor.role === 'group') {
      if (m.responderGroupId !== actor.id) return 'Not your question.';
    } else if (m.responderType !== 'instructor' && !m.takenOverBy) {
      return 'Take over this match first.';
    }
    const text = cleanText(raw, MAX_ANSWER);
    if (!text) return 'Type an answer first.';
    e.humanText = text;
    if (actor.role === 'instructor') e.humanChecked = true; // instructors are trusted
    else this.d.requestModeration({ exchangeId: e.id, question: e.question, text });
    this.tryRelease(e);
  }

  private updateGuess(actor: Actor, exchangeId: string, v: number): Result {
    const e = this.exchange(exchangeId);
    if (!e || e.state !== 'released') return;
    const m = this.matchOf(e);
    const isAsker =
      m.interrogatorType === 'instructor'
        ? actor.role === 'instructor' && m.instructorId === actor.id
        : actor.role === 'group' && m.interrogatorId === actor.id;
    if (!isAsker || m.round !== this.s.round || !isActive(this.s.phase)) return;
    if (e.recordedGuess !== null) return; // locked once the next question is asked or the round ends
    const x = Number(v);
    if (!Number.isFinite(x)) return;
    e.slider = Math.max(-1, Math.min(1, Math.round(x * 100) / 100));
  }

  private tryRelease(e: Exchange) {
    if (e.state !== 'pending' || e.humanText === undefined || e.llmText === undefined || !e.humanChecked) return;
    e.humanSide = this.d.rng() < 0.5 ? 'left' : 'right';
    e.state = 'released';
    e.releasedAt = this.now();
  }

  private block(exchangeId: string, by: string): Result {
    const e = this.exchange(exchangeId);
    if (!e) return 'No such question.';
    if (e.state === 'blocked') return;
    if (e.state === 'void') return 'That question was already voided.';
    const m = this.matchOf(e);
    if (m.round !== this.s.round || !isActive(this.s.phase)) return 'That round is over.';
    e.state = 'blocked';
    e.blockedBy = by;
    e.recordedGuess = null;
    delete e.humanText;
    delete e.llmText;
    delete e.humanSide;
  }

  llmResult(exchangeId: string, r: LlmResult) {
    const e = this.exchange(exchangeId);
    if (!e || e.state !== 'pending') return;
    if (r.kind === 'decline') {
      e.state = 'blocked';
      e.blockedBy = 'llm';
      delete e.humanText;
      this.alert(`Auto-blocked a question: "${e.question.slice(0, 80)}"`);
    } else if (r.kind === 'error') {
      e.state = 'void';
      e.voidReason = 'technical';
      delete e.humanText;
      this.alert(`AI error, question voided (${r.msg.slice(0, 120)})`);
    } else {
      e.llmText = r.text;
      this.tryRelease(e);
    }
  }

  /**
   * Safety verdict on a student's answer.
   * - flag: the answerer is asked to write a new answer (the AI answer is kept, the asker sees a short
   *   wait message). After MAX_ANSWER_FLAGS flags the question is voided so it can't loop forever.
   * - error: the question is voided (fail closed: unchecked text is never released).
   */
  moderationResult(exchangeId: string, r: ModerationResult) {
    const e = this.exchange(exchangeId);
    if (!e || e.state !== 'pending' || e.humanText === undefined || e.humanChecked) return;
    if (r.kind === 'ok') {
      e.humanChecked = true;
      this.tryRelease(e);
      return;
    }
    const shown = e.humanText.slice(0, 80);
    delete e.humanText;
    if (r.kind === 'flag') {
      e.answerFlags = (e.answerFlags ?? 0) + 1;
      if (e.answerFlags >= MAX_ANSWER_FLAGS) {
        delete e.llmText;
        e.state = 'void';
        e.voidReason = 'answer';
        this.alert(`Student answer flagged ${e.answerFlags} times, question voided. Last: "${shown}"`);
      } else {
        this.alert(`Student answer flagged, asked to rewrite: "${shown}"`);
      }
    } else {
      delete e.llmText;
      e.state = 'void';
      e.voidReason = 'technical';
      this.alert(`Safety check failed, question voided (${r.msg.slice(0, 120)})`);
    }
  }

  /** Student answers still waiting on the safety check (re-queued after a server restart). */
  pendingModeration(): ModerationRequest[] {
    return this.s.exchanges
      .filter((e) => e.state === 'pending' && e.humanText !== undefined && !e.humanChecked)
      .map((e) => ({ exchangeId: e.id, question: e.question, text: e.humanText! }));
  }

  /** Exchanges still waiting on the LLM (used to re-queue after a server restart). */
  pendingLlm(): LlmRequest[] {
    return this.s.exchanges
      .filter((e) => e.state === 'pending' && e.llmText === undefined)
      .map((e) => {
        const prior = this.s.exchanges.filter(
          (x) => x.matchId === e.matchId && x.idx < e.idx && x.state === 'released' && x.llmText,
        );
        return { exchangeId: e.id, question: e.question, history: prior.map((x) => ({ q: x.question, a: x.llmText! })) };
      });
  }
}
