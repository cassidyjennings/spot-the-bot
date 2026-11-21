// THE anti-leak boundary. Every byte a student phone or the projector receives is built here.
// Before a round's reveal, student payloads never contain humanSide, humanText/llmText labels,
// or the other group's name. tests/views.test.ts enforces this.
import { classStats, exchangeScore, exchangesOf, groupScores, isScored, round2, type ClassStats } from './scoring';
import { flaggedTerms } from './moderation';
import type { Exchange, ExchangeState, Group, Instructor, Match, Phase, Round, RoomState, Side } from './types';

interface Clock {
  serverNow: number;
  phase: Phase;
  round: number;
  roundEndsAt: number | null;
  pausedRemaining: number | null;
  graceEndsAt: number | null;
  section: string;
}

export interface InterrogatorExchangeView {
  id: string;
  idx: number;
  question: string;
  state: ExchangeState;
  left?: string;
  right?: string;
  slider: number;
  recordedGuess: number | null;
  /** True while the other group is rewriting an answer that failed the safety check. */
  retry?: boolean;
}

export interface ResponderExchangeView {
  id: string;
  idx: number;
  question: string;
  answered: boolean;
  myAnswer?: string;
  /** True when the last answer was rejected and needs rewriting. */
  redo?: boolean;
}

export interface RevealExchangeView {
  idx: number;
  question: string;
  state: ExchangeState;
  left?: string;
  right?: string;
  humanSide?: Side;
  recordedGuess: number | null;
  slider: number;
  s: number | null;
}

export interface RoundResultView {
  round: Round;
  role: 'interrogator' | 'responder';
  opponent: 'group' | 'instructor';
  score: number;
  exchanges: RevealExchangeView[];
}

export interface GroupView extends Clock {
  kind: 'group';
  me: { id: string; name: string };
  groupCount: number;
  role: 'lobby' | 'interrogator' | 'responder' | 'waiting' | 'none';
  opponent: 'group' | 'instructor' | null;
  interrogation?: InterrogatorExchangeView[];
  responding?: ResponderExchangeView[];
  results?: RoundResultView[];
  totalScore?: number;
  stats?: StatsBundle;
}

export interface StatsBundle {
  r1?: ClassStats;
  r2?: ClassStats;
  all?: ClassStats;
}

export interface InstructorMatchView extends Match {
  interrogatorName: string;
  responderName: string;
  status: 'awaiting question' | 'awaiting answer' | 'awaiting slider' | 'idle';
  exchanges: (Exchange & { flags: string[] })[];
}

export interface InstructorView extends Clock {
  kind: 'instructor';
  me: { id: string; name: string };
  config: RoomState['config'];
  groups: Omit<Group, 'token'>[];
  instructors: Omit<Instructor, 'token'>[];
  matches: InstructorMatchView[];
  waitingGroupIds: string[];
  alerts: RoomState['alerts'];
  llm: RoomState['llm'];
  scores: Record<string, { r1: number; r2: number }>;
  stats: StatsBundle;
}

export interface DisplayView extends Clock {
  kind: 'display';
  groupCount: number;
  questionsThisRound: number;
  stats: StatsBundle;
  /** Ranked by total score; empty until Round 1 is revealed. */
  leaderboard: { name: string; r1: number; r2: number | null; total: number }[];
}

const ACTIVE: Record<Round, Phase> = { 1: 'round1_active', 2: 'round2_active' };
const ORDER: Phase[] = ['lobby', 'round1_active', 'round1_reveal', 'round2_active', 'round2_reveal', 'ended'];

/** A round's truth is visible once the phase has moved past that round's active phase. */
export function roundRevealed(phase: Phase, r: Round): boolean {
  return ORDER.indexOf(phase) > ORDER.indexOf(ACTIVE[r]);
}

export function isActive(phase: Phase) {
  return phase === 'round1_active' || phase === 'round2_active';
}

function clock(s: RoomState, now: number): Clock {
  return {
    serverNow: now,
    phase: s.phase,
    round: s.round,
    roundEndsAt: s.roundEndsAt,
    pausedRemaining: s.pausedRemaining,
    graceEndsAt: s.graceEndsAt,
    section: s.sectionName,
  };
}

export function presentGroups(s: RoomState) {
  return s.groups.filter((g) => !g.removed);
}

function statsBundle(s: RoomState): StatsBundle {
  const b: StatsBundle = {};
  if (roundRevealed(s.phase, 1)) b.r1 = classStats(s, [1]);
  if (roundRevealed(s.phase, 2)) {
    b.r2 = classStats(s, [2]);
    b.all = classStats(s, [1, 2]);
  }
  return b;
}

function matchFor(s: RoomState, groupId: string, round: number): Match | undefined {
  return s.matches.find(
    (m) => m.round === round && (m.interrogatorId === groupId || m.responderGroupId === groupId),
  );
}

function sides(e: Exchange): { left?: string; right?: string } {
  if (e.state !== 'released' || !e.humanSide) return {};
  return e.humanSide === 'left'
    ? { left: e.humanText, right: e.llmText }
    : { left: e.llmText, right: e.humanText };
}

export function groupView(s: RoomState, groupId: string, now: number): GroupView {
  const g = s.groups.find((x) => x.id === groupId)!;
  const base: GroupView = {
    kind: 'group',
    ...clock(s, now),
    me: { id: g.id, name: g.name },
    groupCount: presentGroups(s).length,
    role: s.phase === 'lobby' ? 'lobby' : 'none',
    opponent: null,
  };

  const m = s.round ? matchFor(s, groupId, s.round) : undefined;
  if (isActive(s.phase)) {
    if (!m) return { ...base, role: 'waiting' };
    const exs = exchangesOf(s, m);
    if (m.interrogatorId === groupId) {
      base.role = 'interrogator';
      base.opponent = m.responderType;
      base.interrogation = exs.map((e) => ({
        id: e.id,
        idx: e.idx,
        question: e.question,
        state: e.state,
        ...sides(e),
        slider: e.slider,
        recordedGuess: e.recordedGuess,
        retry: e.state === 'pending' && (e.answerFlags ?? 0) > 0,
      }));
    } else {
      base.role = 'responder';
      base.opponent = 'group';
      base.responding = exs
        .filter((e) => e.state === 'pending' || e.state === 'released')
        .map((e) => ({
          id: e.id,
          idx: e.idx,
          question: e.question,
          answered: e.humanText !== undefined,
          myAnswer: e.humanText,
          redo: e.humanText === undefined && (e.answerFlags ?? 0) > 0,
        }));
    }
    return base;
  }

  // Reveal / ended: results for every revealed round this group played.
  const results: RoundResultView[] = [];
  let total = 0;
  for (const r of [1, 2] as Round[]) {
    if (!roundRevealed(s.phase, r)) continue;
    const rm = matchFor(s, groupId, r);
    if (!rm) continue;
    const score = groupScores(s, r).get(groupId) ?? 0;
    total += score;
    // Show only the latest round's transcript on the reveal screen; final screen shows both.
    results.push({
      round: r,
      role: rm.interrogatorId === groupId ? 'interrogator' : 'responder',
      opponent: rm.interrogatorId === groupId ? rm.responderType : 'group',
      score: round2(score),
      exchanges: exchangesOf(s, rm).map((e) => ({
        idx: e.idx,
        question: e.state === 'blocked' ? '(blocked question)' : e.question,
        state: e.state,
        ...sides(e),
        humanSide: e.state === 'released' ? e.humanSide : undefined,
        recordedGuess: e.recordedGuess,
        slider: e.slider,
        s: isScored(e) ? round2(exchangeScore(e.recordedGuess, e.humanSide)) : null,
      })),
    });
  }
  // Top/bottom group names go only to instructors and the projector: on a phone they could
  // reveal who the other group was.
  const stats = statsBundle(s);
  for (const k of ['r1', 'r2', 'all'] as const) {
    if (stats[k]) stats[k] = { ...stats[k]!, top: [], bottom: [] };
  }
  return { ...base, results, totalScore: round2(total), stats };
}

export function matchStatus(s: RoomState, m: Match, exs: Exchange[]): InstructorMatchView['status'] {
  if (!isActive(s.phase) || m.round !== s.round) return 'idle';
  const last = exs[exs.length - 1];
  if (last?.state === 'pending') return 'awaiting answer';
  if (last?.state === 'released' && last.slider === 0 && last.recordedGuess === null) return 'awaiting slider';
  return 'awaiting question';
}

export function instructorView(s: RoomState, instructorId: string, now: number): InstructorView {
  const me = s.instructors.find((i) => i.id === instructorId)!;
  const name = (id?: string) => s.groups.find((g) => g.id === id)?.name ?? '?';
  const instName = (id?: string) => s.instructors.find((i) => i.id === id)?.name ?? 'unassigned';
  const r1 = groupScores(s, 1);
  const r2 = groupScores(s, 2);
  const scores: InstructorView['scores'] = {};
  for (const g of s.groups) scores[g.id] = { r1: round2(r1.get(g.id) ?? 0), r2: round2(r2.get(g.id) ?? 0) };
  const inRound = new Set(s.matches.filter((m) => m.round === s.round).map((m) => m.interrogatorId));
  for (const m of s.matches) if (m.round === s.round && m.responderGroupId) inRound.add(m.responderGroupId);

  return {
    kind: 'instructor',
    ...clock(s, now),
    me: { id: me.id, name: me.name },
    config: s.config,
    groups: s.groups.map(({ token: _t, ...g }) => g),
    instructors: s.instructors.map(({ token: _t, ...i }) => i),
    matches: s.matches.map((m) => {
      const exs = exchangesOf(s, m);
      return {
        ...m,
        interrogatorName: name(m.interrogatorId),
        responderName: m.responderType === 'group' ? name(m.responderGroupId) : `Instructor: ${instName(m.instructorId)}`,
        status: matchStatus(s, m, exs),
        exchanges: exs.map((e) => ({ ...e, flags: flaggedTerms(e.question) })),
      };
    }),
    waitingGroupIds:
      isActive(s.phase) ? presentGroups(s).filter((g) => !inRound.has(g.id)).map((g) => g.id) : [],
    alerts: s.alerts,
    llm: s.llm,
    scores,
    stats: statsBundle(s),
  };
}

function leaderboard(s: RoomState): DisplayView['leaderboard'] {
  if (!roundRevealed(s.phase, 1)) return [];
  const r1 = groupScores(s, 1);
  const r2 = groupScores(s, 2);
  const has2 = roundRevealed(s.phase, 2);
  return presentGroups(s)
    .map((g) => {
      const a = round2(r1.get(g.id) ?? 0);
      const b = has2 ? round2(r2.get(g.id) ?? 0) : null;
      return { name: g.name, r1: a, r2: b, total: round2(a + (b ?? 0)) };
    })
    .sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));
}

export function displayView(s: RoomState, now: number): DisplayView {
  const ids = new Set(s.matches.filter((m) => m.round === s.round).map((m) => m.id));
  return {
    kind: 'display',
    ...clock(s, now),
    groupCount: presentGroups(s).length,
    questionsThisRound: s.exchanges.filter((e) => ids.has(e.matchId) && e.state !== 'void').length,
    stats: statsBundle(s),
    leaderboard: leaderboard(s),
  };
}
