// Anti-leak: before a round's reveal, student and projector payloads must not say which side is human.
import { describe, expect, it } from 'vitest';
import { displayView, groupView } from '../shared/views';
import { lobby } from './helpers';

const FORBIDDEN = ['humanSide', 'humanText', 'llmText', 'blockedBy', 'interrogatorId', 'responderGroupId', 'token'];

function playSomeExchanges(h: ReturnType<typeof lobby>) {
  for (const m of h.engine.currentMatches()) {
    const ask = (q: string) => h.engine.handle({ role: 'group', id: m.interrogatorId }, { t: 'question:submit', text: q });
    for (let k = 0; k < 3; k++) {
      ask(`question ${k}`);
      const e = h.engine.s.exchanges[h.engine.s.exchanges.length - 1];
      if (m.responderType === 'group') {
        h.engine.handle({ role: 'group', id: m.responderGroupId! }, { t: 'answer:submit', exchangeId: e.id, text: `HUMAN-${k}` });
      } else {
        h.engine.handle({ role: 'instructor', id: h.inst.id }, { t: 'answer:submit', exchangeId: e.id, text: `HUMAN-${k}` });
      }
      h.engine.llmResult(e.id, { kind: 'ok', text: `LLM-${k}` });
      h.engine.handle({ role: 'group', id: m.interrogatorId }, { t: 'guess:update', exchangeId: e.id, v: 0.5 });
    }
    ask('pending one'); // leave one pending
  }
}

function assertNoLeak(h: ReturnType<typeof lobby>) {
  const names = h.groups.map((g) => g.name);
  for (const g of h.groups) {
    const json = JSON.stringify(groupView(h.engine.s, g.id, h.now()));
    for (const k of FORBIDDEN) expect(json).not.toContain(`"${k}"`);
    for (const other of names) if (other !== g.name) expect(json).not.toContain(other);
  }
  const d = JSON.stringify(displayView(h.engine.s, h.now()));
  for (const k of FORBIDDEN) expect(d).not.toContain(`"${k}"`);
}

describe('reveal gating', () => {
  for (let n = 1; n <= 12; n++) {
    it(`n=${n}: no leak during Round 1 or Round 2`, () => {
      const h = lobby(n, n);
      h.engine.handle(h.I, { t: 'round:start' });
      playSomeExchanges(h);
      assertNoLeak(h);
      h.engine.handle(h.I, { t: 'round:reveal' });
      h.engine.handle(h.I, { t: 'round:start' });
      playSomeExchanges(h);
      assertNoLeak(h);
    });
  }

  it('reveal shows labels and scores but still no opponent name', () => {
    const h = lobby(2);
    h.engine.handle(h.I, { t: 'round:start' });
    playSomeExchanges(h);
    h.engine.handle(h.I, { t: 'round:reveal' });
    const m = h.engine.currentMatches()[0];
    const v = groupView(h.engine.s, m.interrogatorId, h.now());
    expect(v.results?.[0].exchanges[0].humanSide).toBeDefined();
    const other = h.groups.find((g) => g.id === m.responderGroupId)!.name;
    expect(JSON.stringify(v)).not.toContain(other);
    expect(v.stats?.r1?.scored).toBe(3);
  });
});
