import type { Exchange, Match, Round, RoomState, Side } from './types';

/** s in [-1, 1]: +1 = fully confident and right about which side is human. */
export function exchangeScore(v: number, humanSide: Side): number {
  return humanSide === 'right' ? v : -v;
}

/** Released exchanges with a recorded guess are the only scored ones. */
export function isScored(e: Exchange): e is Exchange & { humanSide: Side; recordedGuess: number } {
  return e.state === 'released' && e.recordedGuess !== null && !!e.humanSide;
}

export function scoreOf(e: Exchange): number | null {
  return isScored(e) ? exchangeScore(e.recordedGuess, e.humanSide) : null;
}

/**
 * Per-group score for a round. The two groups in a match are on the same team against the AI:
 * both earn s, so both gain when the interrogator spots the human and both lose when the AI fools them.
 */
export function groupScores(state: RoomState, round: Round): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (id: string, x: number) => scores.set(id, (scores.get(id) ?? 0) + x);
  for (const m of state.matches) {
    if (m.round !== round) continue;
    // An instructor judging has no group score; the answering group still earns s.
    const groupAsks = m.interrogatorType !== 'instructor';
    if (groupAsks) add(m.interrogatorId, 0);
    if (m.responderType === 'group' && m.responderGroupId) add(m.responderGroupId, 0);
    for (const e of exchangesOf(state, m)) {
      const s = scoreOf(e);
      if (s === null) continue;
      if (groupAsks) add(m.interrogatorId, s);
      if (m.responderType === 'group' && m.responderGroupId) add(m.responderGroupId, s);
    }
  }
  return scores;
}

export function exchangesOf(state: RoomState, m: Match): Exchange[] {
  return state.exchanges.filter((e) => e.matchId === m.id).sort((a, b) => a.idx - b.idx);
}

export interface ClassStats {
  scored: number;
  questions: number;
  pctCorrect: number | null;
  pctLlmJudgedHuman: number | null;
  avgConfidence: number | null;
  avgConfidenceRight: number | null;
  avgConfidenceWrong: number | null;
  /** 10 bins over s in [-1, 1]. */
  histogram: number[];
  top: { name: string; score: number }[];
  bottom: { name: string; score: number }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function classStats(state: RoomState, rounds: Round[]): ClassStats {
  const matchIds = new Set(state.matches.filter((m) => rounds.includes(m.round)).map((m) => m.id));
  const exs = state.exchanges.filter((e) => matchIds.has(e.matchId));
  const scored = exs.filter(isScored);
  const ss = scored.map((e) => exchangeScore(e.recordedGuess, e.humanSide));
  const conf = scored.map((e) => Math.abs(e.recordedGuess));
  const histogram = new Array(10).fill(0);
  for (const s of ss) histogram[Math.min(9, Math.floor((s + 1) * 5))]++;

  const totals = new Map<string, number>();
  for (const r of rounds) {
    for (const [id, x] of groupScores(state, r)) totals.set(id, (totals.get(id) ?? 0) + x);
  }
  const ranked = [...totals.entries()]
    .map(([id, score]) => ({ name: state.groups.find((g) => g.id === id)?.name ?? '?', score: round2(score) }))
    .sort((a, b) => b.score - a.score);

  return {
    scored: scored.length,
    questions: exs.filter((e) => e.state !== 'void').length,
    pctCorrect: ss.length ? ss.filter((s) => s > 0).length / ss.length : null,
    pctLlmJudgedHuman: ss.length ? ss.filter((s) => s < 0).length / ss.length : null,
    avgConfidence: mean(conf),
    avgConfidenceRight: mean(scored.filter((_, i) => ss[i] > 0).map((e) => Math.abs(e.recordedGuess))),
    avgConfidenceWrong: mean(scored.filter((_, i) => ss[i] < 0).map((e) => Math.abs(e.recordedGuess))),
    histogram,
    // At most half the groups in each list so top and bottom never overlap.
    top: ranked.slice(0, Math.min(3, Math.floor(ranked.length / 2))),
    bottom: ranked.slice(ranked.length - Math.min(3, Math.floor(ranked.length / 2))).reverse(),
  };
}

export const round2 = (x: number) => Math.round(x * 100) / 100;
