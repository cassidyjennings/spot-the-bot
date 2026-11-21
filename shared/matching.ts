import type { Match, Round } from './types';

export type Rng = () => number;

/** A match before it gets an id. */
export type MatchPlan = Omit<Match, 'id'>;

export function shuffle<T>(arr: T[], rng: Rng = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Picks the connected instructor with the fewest matches in `plans`.
 * Falls back to any instructor, then to undefined (unassigned; any instructor can claim it).
 */
function pickInstructor(
  plans: MatchPlan[],
  connected: string[],
  all: string[],
): string | undefined {
  const pool = connected.length ? connected : all;
  if (!pool.length) return undefined;
  const load = (id: string) => plans.filter((p) => p.instructorId === id).length;
  return pool.reduce((best, id) => (load(id) < load(best) ? id : best), pool[0]);
}

function instructorMatch(
  round: Round,
  interrogatorId: string,
  plans: MatchPlan[],
  inst: { connected: string[]; all: string[] },
  oddGroup: boolean,
): MatchPlan {
  return {
    round,
    interrogatorId,
    responderType: 'instructor',
    instructorId: pickInstructor(plans, inst.connected, inst.all),
    oddGroup,
  };
}

/** An instructor asks (types live) and judges; the group answers next to the AI. Gives the odd group an answering turn. */
function instructorAsksMatch(
  round: Round,
  responderGroupId: string,
  plans: MatchPlan[],
  inst: { connected: string[]; all: string[] },
): MatchPlan {
  return {
    round,
    interrogatorId: '',
    interrogatorType: 'instructor',
    responderType: 'group',
    responderGroupId,
    instructorId: pickInstructor(plans, inst.connected, inst.all),
    oddGroup: true,
  };
}

/** Round 1: first ceil(n/2) shuffled groups interrogate; an odd one out plays an instructor. */
export function planRound1(
  groupIds: string[],
  inst: { connected: string[]; all: string[] },
  rng: Rng = Math.random,
): MatchPlan[] {
  const g = shuffle(groupIds, rng);
  const n = g.length;
  const k = Math.ceil(n / 2);
  const interrogators = g.slice(0, k);
  const responders = g.slice(k);
  const plans: MatchPlan[] = [];
  interrogators.forEach((id, i) => {
    const r = responders[i];
    if (r) {
      plans.push({ round: 1, interrogatorId: id, responderType: 'group', responderGroupId: r, oddGroup: false });
    } else {
      plans.push(instructorMatch(1, id, plans, inst, true));
    }
  });
  return plans;
}

/**
 * Round 2: roles swap. Former group responders interrogate former interrogators.
 * The odd group (which interrogated an instructor in Round 1) now answers an instructor's questions,
 * so every group both asks and answers. Anyone who missed Round 1 interrogates an instructor.
 * If removals unbalance the pools, leftovers on either side interrogate an instructor,
 * so no present group is idle.
 */
export function planRound2(
  round1: Pick<Match, 'interrogatorId' | 'responderType' | 'responderGroupId' | 'oddGroup'>[],
  presentGroupIds: string[],
  inst: { connected: string[]; all: string[] },
  rng: Rng = Math.random,
): MatchPlan[] {
  const present = new Set(presentGroupIds);
  const r1Interrogators = new Set(round1.map((m) => m.interrogatorId));
  const r1Responders = new Set(
    round1.filter((m) => m.responderType === 'group').map((m) => m.responderGroupId!),
  );
  const oddIds = new Set(round1.filter((m) => m.oddGroup).map((m) => m.interrogatorId));
  const prevPairs = new Set(
    round1
      .filter((m) => m.responderType === 'group')
      .map((m) => pairKey(m.interrogatorId, m.responderGroupId!)),
  );

  const newInterrogators = presentGroupIds.filter((id) => r1Responders.has(id));
  const newResponders = presentGroupIds.filter((id) => r1Interrogators.has(id) && !oddIds.has(id));
  const oddResponders = presentGroupIds.filter((id) => oddIds.has(id));
  const toInstructor = presentGroupIds.filter(
    (id) => !oddIds.has(id) && !r1Interrogators.has(id) && !r1Responders.has(id),
  );

  // Try a few shuffles to avoid repeating a Round 1 pair (only possible with enough groups).
  const tries = presentGroupIds.length >= 4 ? 50 : 1;
  let best: string[] = newResponders;
  let bestRepeats = Infinity;
  const ints = shuffle(newInterrogators, rng);
  for (let t = 0; t < tries; t++) {
    const cand = shuffle(newResponders, rng);
    const repeats = ints.reduce(
      (acc, id, i) => acc + (cand[i] && prevPairs.has(pairKey(id, cand[i])) ? 1 : 0),
      0,
    );
    if (repeats < bestRepeats) {
      best = cand;
      bestRepeats = repeats;
      if (repeats === 0) break;
    }
  }

  const plans: MatchPlan[] = [];
  const pairs = Math.min(ints.length, best.length);
  for (let i = 0; i < pairs; i++) {
    plans.push({ round: 2, interrogatorId: ints[i], responderType: 'group', responderGroupId: best[i], oddGroup: false });
  }
  for (const id of oddResponders) plans.push(instructorAsksMatch(2, id, plans, inst));
  const leftovers = [...ints.slice(pairs), ...best.slice(pairs)];
  for (const id of [...toInstructor, ...leftovers]) {
    if (present.has(id)) plans.push(instructorMatch(2, id, plans, inst, false));
  }
  return plans;
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
