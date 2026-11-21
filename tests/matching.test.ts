import { describe, expect, it } from 'vitest';
import { planRound1, planRound2 } from '../shared/matching';
import { mulberry32 } from './helpers';

const inst = { connected: ['i1', 'i2'], all: ['i1', 'i2'] };

function rolesOf(plans: ReturnType<typeof planRound1>) {
  // Matches where an instructor asks have no interrogator group.
  const interrog = plans.filter((p) => p.interrogatorType !== 'instructor').map((p) => p.interrogatorId);
  const resp = plans.filter((p) => p.responderType === 'group').map((p) => p.responderGroupId!);
  return { interrog, resp, all: [...interrog, ...resp] };
}

describe('matching', () => {
  for (let n = 1; n <= 12; n++) {
    it(`n=${n}: every group plays, roles swap, odd group asks an instructor then answers one`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const rng = mulberry32(seed * 31 + n);
        const ids = Array.from({ length: n }, (_, i) => `g${i}`);
        const r1 = planRound1(ids, inst, rng);
        const a = rolesOf(r1);
        expect(a.all.sort()).toEqual([...ids].sort()); // each group exactly once
        expect(a.interrog.length).toBe(Math.ceil(n / 2));
        const odd1 = r1.filter((p) => p.oddGroup);
        expect(odd1.length).toBe(n % 2);
        odd1.forEach((p) => expect(p.responderType).toBe('instructor'));

        const r2 = planRound2(r1, ids, inst, rng);
        const b = rolesOf(r2);
        expect(b.all.sort()).toEqual([...ids].sort());
        // swap: R1 group responders now interrogate; R1 interrogators (non-odd) now respond
        for (const id of a.resp) expect(b.interrog).toContain(id);
        for (const p of r1.filter((p) => !p.oddGroup)) expect(b.resp).toContain(p.interrogatorId);
        for (const p of odd1) {
          // the odd group answers an instructor's questions instead of asking again
          const m = r2.find((x) => x.responderGroupId === p.interrogatorId)!;
          expect(m.interrogatorType).toBe('instructor');
          expect(m.responderType).toBe('group');
          expect(m.oddGroup).toBe(true);
          expect(b.interrog).not.toContain(p.interrogatorId);
        }
        // everyone asks exactly once and answers exactly once across the two rounds (n >= 2)
        if (n >= 2) {
          const asked = new Map<string, number>();
          const answered = new Map<string, number>();
          for (const p of [...r1, ...r2]) {
            if (p.interrogatorType !== 'instructor') asked.set(p.interrogatorId, (asked.get(p.interrogatorId) ?? 0) + 1);
            if (p.responderType === 'group') answered.set(p.responderGroupId!, (answered.get(p.responderGroupId!) ?? 0) + 1);
          }
          for (const id of ids) {
            expect(asked.get(id)).toBe(1);
            expect(answered.get(id)).toBe(1);
          }
        }
        if (n >= 4) {
          const prev = new Set(r1.filter((p) => p.responderGroupId).map((p) => [p.interrogatorId, p.responderGroupId].sort().join()));
          const repeats = r2.filter((p) => p.responderGroupId && prev.has([p.interrogatorId, p.responderGroupId].sort().join()));
          expect(repeats.length).toBe(0);
        }
      }
    });
  }

  it('n=0 plans nothing', () => {
    expect(planRound1([], inst)).toEqual([]);
  });

  it('assigns instructor matches to the least-loaded connected instructor', () => {
    const r2 = planRound2(
      [
        { interrogatorId: 'a', responderType: 'instructor', oddGroup: true },
      ],
      ['a', 'late1', 'late2'],
      { connected: ['i1', 'i2'], all: ['i1', 'i2', 'i3'] },
    );
    const load = r2.map((p) => p.instructorId);
    expect(load.filter((x) => x === 'i1').length).toBeLessThanOrEqual(2);
    expect(load).toContain('i2');
    expect(load).not.toContain('i3');
  });

  it('late joiners and unbalanced pools never leave a group idle', () => {
    const r1 = planRound1(['a', 'b', 'c', 'd'], inst, mulberry32(3));
    // one R1 interrogator removed, one late joiner added
    const present = ['a', 'b', 'c', 'd', 'e'].filter((x) => x !== r1[0].interrogatorId);
    const r2 = planRound2(r1, present, inst, mulberry32(4));
    expect(rolesOf(r2).all.sort()).toEqual(present.sort());
  });
});
