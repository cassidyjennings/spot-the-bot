import { describe, expect, it } from 'vitest';
import { MAX_ANSWER_FLAGS } from '../shared/engine';
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

describe('student answer safety check', () => {
  function pendingAnswered() {
    const h = lobby(2);
    h.autoMod.on = false;
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q' });
    const e = h.engine.s.exchanges[0];
    h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e.id, text: 'my answer' });
    return { h, m, e };
  }

  it('holds the release until the check passes, even when the AI answer is ready', () => {
    const { h, e } = pendingAnswered();
    expect(h.mod).toEqual([{ exchangeId: e.id, question: 'q', text: 'my answer' }]);
    h.engine.llmResult(e.id, { kind: 'ok', text: 'bot' });
    expect(e.state).toBe('pending');
    h.engine.moderationResult(e.id, { kind: 'ok' });
    expect(e.state).toBe('released');
  });

  it('works when the check finishes before the AI answer', () => {
    const { h, e } = pendingAnswered();
    h.engine.moderationResult(e.id, { kind: 'ok' });
    expect(e.state).toBe('pending');
    h.engine.llmResult(e.id, { kind: 'ok', text: 'bot' });
    expect(e.state).toBe('released');
  });

  it('a flagged answer asks the answerer to rewrite; the asker sees a wait message', () => {
    const { h, m, e } = pendingAnswered();
    h.engine.llmResult(e.id, { kind: 'ok', text: 'bot' });
    h.engine.moderationResult(e.id, { kind: 'flag' });
    expect(e.state).toBe('pending');
    expect(e.humanText).toBeUndefined();
    expect(e.llmText).toBe('bot'); // AI answer kept: no extra Gemini call
    expect(h.engine.s.alerts[0].text).toMatch(/asked to rewrite/);

    const asker = groupView(h.engine.s, m.interrogatorId, h.now());
    expect(asker.interrogation![0].retry).toBe(true);
    const answerer = groupView(h.engine.s, m.responderGroupId!, h.now());
    expect(answerer.responding![0]).toMatchObject({ answered: false, redo: true });

    // the rewrite is checked again and then released
    expect(h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e.id, text: 'better' })).toBeUndefined();
    expect(h.mod).toHaveLength(2);
    expect(e.state).toBe('pending');
    h.engine.moderationResult(e.id, { kind: 'ok' });
    expect(e.state).toBe('released');
    expect(groupView(h.engine.s, m.interrogatorId, h.now()).interrogation![0].retry).toBe(false);
  });

  it('voids the question after repeated flags', () => {
    const { h, m, e } = pendingAnswered();
    for (let i = 0; i < MAX_ANSWER_FLAGS; i++) {
      expect(e.state).toBe('pending');
      h.engine.moderationResult(e.id, { kind: 'flag' });
      if (i < MAX_ANSWER_FLAGS - 1) {
        h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e.id, text: `try ${i}` });
      }
    }
    expect(e.state).toBe('void');
    expect(e.voidReason).toBe('answer');
  });

  it('a failed check voids the question (fails closed)', () => {
    const { h, e } = pendingAnswered();
    h.engine.moderationResult(e.id, { kind: 'error', msg: 'HTTP 500' });
    expect(e.state).toBe('void');
    expect(e.humanText).toBeUndefined();
    h.engine.llmResult(e.id, { kind: 'ok', text: 'late' }); // ignored
    expect(e.state).toBe('void');
  });

  it('ignores a late verdict after an instructor block', () => {
    const { h, e } = pendingAnswered();
    h.engine.handle(h.I, { t: 'exchange:block', exchangeId: e.id });
    h.engine.moderationResult(e.id, { kind: 'ok' });
    expect(e.state).toBe('blocked');
  });

  it('re-queues unchecked answers after a restart', () => {
    const { h, e } = pendingAnswered();
    expect(h.engine.pendingModeration()).toEqual([{ exchangeId: e.id, question: 'q', text: 'my answer' }]);
    h.engine.moderationResult(e.id, { kind: 'ok' });
    expect(h.engine.pendingModeration()).toEqual([]);
  });

  it('skips the check for instructor answers', () => {
    const h = lobby(1);
    h.autoMod.on = false;
    h.engine.handle(h.I, { t: 'round:start' });
    const m = h.engine.currentMatches()[0];
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q' });
    const e = h.engine.s.exchanges[0];
    h.engine.handle(h.I, { t: 'answer:submit', exchangeId: e.id, text: 'from instructor' });
    expect(h.mod).toHaveLength(0);
    h.engine.llmResult(e.id, { kind: 'ok', text: 'bot' });
    expect(e.state).toBe('released');
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
    // the odd group answers an instructor's questions in Round 2, so everyone asks and answers once
    expect(r2.find((m) => m.responderGroupId === odd.interrogatorId)?.interrogatorType).toBe('instructor');
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

describe('instructor takeover and claim', () => {
  it('takeover lets the instructor answer for a stalled group; first answer wins; give-back restores it', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'round:start' });
    const m = firstGroupMatch(h);
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q1' });
    const e = h.engine.s.exchanges[0];
    expect(h.engine.handle(h.I, { t: 'match:takeover', matchId: m.id })).toBeUndefined();
    expect(h.engine.handle(h.I, { t: 'answer:submit', exchangeId: e.id, text: 'from instructor' })).toBeUndefined();
    expect(e.humanText).toBe('from instructor');
    // first answer wins: the stalled group answering afterwards is rejected
    expect(h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e.id, text: 'too late' })).toBeTruthy();
    expect(e.humanText).toBe('from instructor');
    h.engine.llmResult(e.id, { kind: 'ok', text: 'bot' });
    expect(e.state).toBe('released');
    expect(h.engine.handle(h.I, { t: 'match:untakeover', matchId: m.id })).toBeUndefined();
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'q2' });
    const e2 = h.engine.s.exchanges[1];
    expect(h.engine.handle(G(m.responderGroupId!), { t: 'answer:submit', exchangeId: e2.id, text: 'back to group' })).toBeUndefined();
  });

  it('Round 2: an instructor types questions live, judges, and the odd group answers', () => {
    const h = lobby(3);
    h.engine.handle(h.I, { t: 'round:start' });
    h.engine.handle(h.I, { t: 'round:end' });
    h.engine.handle(h.I, { t: 'round:start' });
    const m = h.engine.currentMatches().find((x) => x.interrogatorType === 'instructor')!;
    expect(m.interrogatorId).toBe('');
    expect(m.instructorId).toBe(h.inst.id);
    const odd = m.responderGroupId!;

    // views: the answering group learns an instructor is asking; names stay hidden
    const rv = groupView(h.engine.s, odd, h.now());
    expect(rv.role).toBe('responder');
    expect(rv.opponent).toBe('instructor');

    // only the assigned instructor can ask; takeover is not offered here
    const other = h.engine.loginInstructor('Other');
    const O = { role: 'instructor' as const, id: other.id };
    expect(h.engine.handle(O, { t: 'iq:submit', matchId: m.id, text: 'hi' })).toMatch(/Claim/);
    expect(h.engine.handle(h.I, { t: 'match:takeover', matchId: m.id })).toMatch(/already asking/);
    expect(h.engine.handle(G(odd), { t: 'iq:submit', matchId: m.id, text: 'hi' })).toBeTruthy(); // groups can't

    expect(h.engine.handle(h.I, { t: 'iq:submit', matchId: m.id, text: 'favorite food?' })).toBeUndefined();
    const e1 = h.engine.s.exchanges[0];
    expect(h.llm.at(-1)!.question).toBe('favorite food?');
    expect(h.engine.handle(h.I, { t: 'iq:submit', matchId: m.id, text: 'again' })).toMatch(/Wait/);
    h.engine.handle(G(odd), { t: 'answer:submit', exchangeId: e1.id, text: 'pizza' });
    h.engine.llmResult(e1.id, { kind: 'ok', text: 'tacos' });
    expect(e1.state).toBe('released');

    // the instructor judges; the asking group's message type and other groups can't move the slider
    const correct = e1.humanSide === 'right' ? 0.6 : -0.6;
    h.engine.handle(G(odd), { t: 'guess:update', exchangeId: e1.id, v: 1 });
    expect(e1.slider).toBe(0);
    h.engine.handle(O, { t: 'iguess:update', exchangeId: e1.id, v: 1 });
    expect(e1.slider).toBe(0);
    h.engine.handle(h.I, { t: 'iguess:update', exchangeId: e1.id, v: correct });
    expect(e1.slider).toBe(correct);
    h.engine.handle(h.I, { t: 'iq:submit', matchId: m.id, text: 'second?' });
    expect(e1.recordedGuess).toBe(correct); // next question locks the guess

    // a claimed match can be asked by the new instructor
    h.engine.handle(O, { t: 'match:claim', matchId: m.id });
    h.engine.llmResult(h.engine.s.exchanges[1].id, { kind: 'error', msg: 'x' }); // void it so a new question is allowed
    expect(h.engine.handle(O, { t: 'iq:submit', matchId: m.id, text: 'from other' })).toBeUndefined();

    // scoring: the answering group earns -s; no score entry for the missing asker
    h.engine.handle(h.I, { t: 'round:end' });
    const sc = groupScores(h.engine.s, 2);
    expect(sc.has('')).toBe(false);
    expect(sc.get(odd)).toBeCloseTo(-0.6);
  });

  it('the odd group plays an instructor who answers its questions', () => {
    const h = lobby(3);
    h.engine.handle(h.I, { t: 'round:start' });
    const m = h.engine.currentMatches().find((x) => x.responderType === 'instructor')!;
    expect(m).toBeTruthy();
    h.engine.handle(G(m.interrogatorId), { t: 'question:submit', text: 'hello?' });
    const e = h.engine.s.exchanges[0];
    expect(h.engine.handle(h.I, { t: 'answer:submit', exchangeId: e.id, text: 'hi from teacher' })).toBeUndefined();
    h.engine.llmResult(e.id, { kind: 'ok', text: 'hi from bot' });
    expect(e.state).toBe('released');
  });
});
