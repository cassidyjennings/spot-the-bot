// Server-side state. Only the worker holds this; clients get projections from views.ts.

export type Phase =
  | 'lobby'
  | 'round1_active'
  | 'round1_reveal'
  | 'round2_active'
  | 'round2_reveal'
  | 'ended';

export type Side = 'left' | 'right';
export type Round = 1 | 2;

export interface Group {
  id: string;
  name: string;
  token: string;
  connected: boolean;
  lastSeen: number;
  joinedAt: number;
  /** Instructor released the name: the next join with this name takes over the group. */
  released: boolean;
  removed: boolean;
}

export interface Instructor {
  id: string;
  name: string;
  token: string;
  connected: boolean;
  lastSeen: number;
}

export interface Match {
  id: string;
  round: Round;
  interrogatorId: string;
  responderType: 'group' | 'instructor';
  responderGroupId?: string;
  /** Assigned instructor for instructor-responder matches (may be unset if none was connected). */
  instructorId?: string;
  /** Instructor answering in place of a stalled responder group. */
  takenOverBy?: string;
  oddGroup: boolean;
  /** Created for a late joiner during the round. */
  late?: boolean;
}

export type ExchangeState = 'pending' | 'released' | 'blocked' | 'void';

export interface Exchange {
  id: string;
  matchId: string;
  idx: number;
  question: string;
  state: ExchangeState;
  humanText?: string;
  llmText?: string;
  humanSide?: Side;
  blockedBy?: string; // instructor id or 'llm'
  voidReason?: string;
  /** Live slider value. Editable at any time, never scored after recordedGuess is set. */
  slider: number;
  /** Slider value captured when the next question was asked or the round ended. Scored. */
  recordedGuess: number | null;
  createdAt: number;
  releasedAt?: number;
}

export interface Alert {
  id: string;
  at: number;
  text: string;
}

export interface RoomConfig {
  roundMs: number;
  graceMs: number;
}

export interface RoomState {
  sessionId: string;
  sectionName: string;
  phase: Phase;
  round: 0 | Round;
  roundEndsAt: number | null;
  /** Set while paused: ms left on the clock. */
  pausedRemaining: number | null;
  graceEndsAt: number | null;
  config: RoomConfig;
  groups: Group[];
  instructors: Instructor[];
  matches: Match[];
  exchanges: Exchange[];
  alerts: Alert[];
  llm: { queued: number; rateLimited: boolean };
  endedAt: number | null;
  seq: number;
}

export const DEFAULT_CONFIG: RoomConfig = { roundMs: 5 * 60_000, graceMs: 60_000 };
export const MAX_QUESTION = 300;
export const MAX_ANSWER = 500;
export const STALE_MS = 45_000;

export function newRoomState(sessionId: string, sectionName: string): RoomState {
  return {
    sessionId,
    sectionName,
    phase: 'lobby',
    round: 0,
    roundEndsAt: null,
    pausedRemaining: null,
    graceEndsAt: null,
    config: { ...DEFAULT_CONFIG },
    groups: [],
    instructors: [],
    matches: [],
    exchanges: [],
    alerts: [],
    llm: { queued: 0, rateLimited: false },
    endedAt: null,
    seq: 1,
  };
}

// ---- Wire protocol ----

export type ClientMsg =
  | { t: 'group:join'; password: string; name: string }
  | { t: 'group:rejoin'; token: string }
  | { t: 'instructor:login'; password: string; name: string }
  | { t: 'instructor:rejoin'; token: string }
  | { t: 'display:rejoin'; token: string }
  | { t: 'ping' }
  | { t: 'question:submit'; text: string }
  | { t: 'answer:submit'; exchangeId: string; text: string }
  | { t: 'guess:update'; exchangeId: string; v: number }
  | { t: 'group:leave' }
  // instructor
  | { t: 'config:set'; roundMinutes: number }
  | { t: 'round:start' }
  | { t: 'round:end' }
  | { t: 'round:reveal' }
  | { t: 'timer:adjust'; deltaMs: number }
  | { t: 'timer:pause' }
  | { t: 'timer:resume' }
  | { t: 'game:end' }
  | { t: 'session:reset' }
  | { t: 'session:delete' }
  | { t: 'exchange:block'; exchangeId: string }
  | { t: 'match:takeover'; matchId: string }
  | { t: 'match:untakeover'; matchId: string }
  | { t: 'match:claim'; matchId: string }
  | { t: 'late:match'; groupId: string }
  | { t: 'group:release'; groupId: string }
  | { t: 'group:remove'; groupId: string }
  | { t: 'alerts:clear' };

export type ServerMsg =
  | { t: 'auth'; role: 'group' | 'instructor' | 'display'; token: string; id: string }
  | { t: 'snapshot'; view: unknown }
  | { t: 'error'; msg: string; fatal?: boolean }
  | { t: 'notice'; msg: string };
