import { describe, expect, it } from 'vitest';
import { exchangeScore, groupScores } from '../shared/scoring';
import { groupView } from '../shared/views';
import { lobby } from './helpers';

const G = (id: string) => ({ role: 'group' as const, id });

function firstGroupMatch(h: ReturnType<typeof lobby>) {
  return h.engine.currentMatches().find((m) => m.responderType === 'group')!;
}

describe('scoring formula', () => {
  it('s = v when human is right, -v when left', () => {
    expect(exchangeScore(1, 'right')).toBe(1);
    expect(exchangeScore(1, 'left')).toBe(-1);
    expect(exchangeScore(-0.4, 'left')).toBe(0.4);
    expect(exchangeScore(0, 'left')).toBe(-0);
  });
});

describe('exchange loop', () => {
  it('holds answers until both exist, then releases with a humanSide', () => {
    const h = lobby(2);
    expect(h.engine.handle(h.I, { t: 'round:start' })).toBeUndefined();
    const m = firstGroupMatch(h);
    expect(h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'fav food?' })).toBeUndefined();
    const ex = h.engine.s.exchanges[0];
    expect(h.llm).toHaveLength(1);
    expect(h.llm[0].history).toEqual([]);

    // only one unresolved question at a time
    expect(h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'again' })).toMatch(/Wait/);

    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: ex.id, text: 'pizza' });
    expect(ex.state).toBe('pending');
    h.engine.llmResult(ex.id, { kind: 'ok', text: 'tacos lol' });
    expect(ex.state).toBe('released');
    expect(['left', 'right']).toContain(ex.humanSide);
  });

  it('records the slider at the next question; later edits are ignored', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    const ask = (q: string) => h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: q });
    ask('q1');
    const e1 = h.engine.s.exchanges[0];
    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e1.id, text: 'a' });
    h.engine.llmResult(e1.id, { kind: 'ok', text: 'b' });
    h.engine.handle(G(m.interrogatorId), { t: 'guess:update', exchangeId: e1.id, v: 0.7 });
    ask('q2');
    expect(e1.recordedGuess).toBe(0.7);
    expect(h.llm[1].history).toEqual([{ q: 'q1', a: 'b' }]); // LLM sees only its own answers
    h.engine.handle(G(m.interrogatorId), { t: 'guess:update', exchangeId: e1.id, v: -1 });
    expect(e1.slider).toBe(0.7); // locked: later edits are ignored
    expect(e1.recordedGuess).toBe(0.7);
  });

  it('interrogator earns s and responder earns -s', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q1' });
    const e1 = h.engine.s.exchanges[0];
    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e1.id, text: 'a' });
    h.engine.llmResult(e1.id, { kind: 'ok', text: 'b' });
    const correct = e1.humanSide === 'right' ? 0.5 : -0.5;
    h.engine.handle(G(m.interrogatorId), { t: 'guess:update', exchangeId: e1.id, v: correct });
    h.engine.handle(h.I, { t: 'round:reveal' });
    const sc = groupScores(h.engine.s, 1);
    expect(sc.get(m.interrogatorId)).toBe(0.5);
    expect(sc.get(m.responderGroupId!)).toBe(-0.5);
  });

  it('LLM decline auto-blocks; instructor block discards answers', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'bad' });
    const e1 = h.engine.s.exchanges[0];
    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e1.id, text: 'x' });
    h.engine.llmResult(e1.id, { kind: 'decline' });
    expect(e1.state).toBe('blocked');
    expect(e1.humanText).toBeUndefined();

    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q2' });
    const e2 = h.engine.s.exchanges[1];
    h.engine.handle(h.I, { t: 'exchange:block', exchangeId: e2.id });
    h.engine.llmResult(e2.id, { kind: 'ok', text: 'late' }); // arrives after block: ignored
    expect(e2.state).toBe('blocked');
    expect(e2.llmText).toBeUndefined();

    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q3' });
    const e3 = h.engine.s.exchanges[2];
    h.engine.llmResult(e3.id, { kind: 'error', msg: 'timeout' });
    expect(e3.state).toBe('void');
    expect(h.engine.s.alerts.length).toBe(2);
  });
});

describe('timer and phases', () => {
  it('rejects questions after the timer and auto-reveals once idle', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'config:set', roundMinutes: 1 });
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q' });
    h.advance(60_000);
    expect(h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'late' })).toMatch(/Time/);
    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: h.engine.s.exchanges[0].id, text: 'a' });
    h.engine.llmResult(h.engine.s.exchanges[0].id, { kind: 'ok', text: 'b' });
    h.advance(14_000);
    expect(h.engine.s.phase).toBe('round1_active');
    h.advance(2_000);
    expect(h.engine.s.phase).toBe('round1_reveal');
  });

  it('waits up to the grace period for a pending answer, then voids it', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'config:set', roundMinutes: 1 });
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q' });
    h.advance(60_000);
    expect(h.engine.s.phase).toBe('round1_active');
    h.advance(30_000);
    expect(h.engine.s.phase).toBe('round1_active');
    h.advance(30_000);
    expect(h.engine.s.phase).toBe('round1_reveal');
    expect(h.engine.s.exchanges[0].state).toBe('void');
  });

  it('gives a few seconds to set the slider when the last answer lands in grace', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'config:set', roundMinutes: 1 });
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q' });
    const e = h.engine.s.exchanges[0];
    h.advance(65_000);
    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e.id, text: 'a' });
    h.engine.llmResult(e.id, { kind: 'ok', text: 'b' });
    h.advance(5_000);
    expect(h.engine.s.phase).toBe('round1_active');
    h.engine.handle(G(m.interrogatorId), { t: 'guess:update', exchangeId: e.id, v: 0.3 });
    h.advance(11_000);
    expect(h.engine.s.phase).toBe('round1_reveal');
    expect(e.recordedGuess).toBe(0.3);
  });

  it('pause freezes the clock; +1 min extends it', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'config:set', roundMinutes: 1 });
    h.engine.handle(h.I, { t: 'round:start' });
    h.advance(20_000);
    h.engine.handle(h.I, { t: 'timer:pause' });
    expect(h.engine.s.pausedRemaining).toBe(40_000);
    h.advance(120_000);
    expect(h.engine.s.phase).toBe('round1_active');
    h.engine.handle(h.I, { t: 'timer:resume' });
    h.engine.handle(h.I, { t: 'timer:adjust', deltaMs: 60_000 });
    expect(h.engine.s.roundEndsAt! - h.now()).toBe(100_000);
  });

  it('runs a full two-round game and swaps roles', () => {
    const h = lobby(5);
    h.engine.handle(h.I, { t: 'round:start' });
    const r1 = h.engine.currentMatches();
    h.engine.handle(h.I, { t: 'round:end' });
    expect(h.engine.s.phase).toBe('round1_reveal');
    h.engine.handle(h.I, { t: 'round:start' });
    expect(h.engine.s.phase).toBe('round2_active');
    const r2 = h.engine.currentMatches();
    const odd = r1.find((m) => m.oddGroup)!;
    expect(r2.find((m) => m.interrogatorId === odd.interrogatorId)?.responderType).toBe('instructor');
    h.engine.handle(h.I, { t: 'round:end' });
    h.engine.handle(h.I, { t: 'game:end' });
    expect(h.engine.s.phase).toBe('ended');
  });

  it('rejects duplicate names; released names can rejoin into the same group', () => {
    const h = lobby(1);
    expect(h.engine.joinGroup('group a')).toHaveProperty('error');
    const g = h.groups[0];
    h.engine.handle(h.I, { t: 'group:release', groupId: g.id });
    const r = h.engine.joinGroup('Group A');
    expect('group' in r && r.group.id).toBe(g.id);
  });

  it('late joiners wait, then can be matched with an instructor', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'round:start' });
    const r = h.engine.joinGroup('Latecomers');
    if ('error' in r) throw new Error();
    expect(groupView(h.engine.s, r.group.id, h.now()).role).toBe('waiting');
    h.engine.handle(h.I, { t: 'late:match', groupId: r.group.id });
    expect(groupView(h.engine.s, r.group.id, h.now()).role).toBe('interrogator');
  });
});

describe('leaving the game', () => {
  it('frees the name and invalidates the old token; the group can rejoin', () => {
    const h = lobby(2);
    const g = h.groups[0];
    const oldToken = g.token;
    expect(h.engine.handle(G(g.id), { t: 'group:leave' })).toBeUndefined();
    expect(h.engine.groupByToken(oldToken)).toBeUndefined();
    const back = h.engine.joinGroup(g.name);
    expect('group' in back && back.group.id).toBe(g.id);
  });
});
