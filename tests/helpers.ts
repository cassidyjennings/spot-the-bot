import { Engine, type LlmRequest, type ModerationRequest } from '../shared/engine';
import { newRoomState } from '../shared/types';

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeEngine(seed = 1) {
  let t = 1_000_000;
  let n = 0;
  const llm: LlmRequest[] = [];
  const mod: ModerationRequest[] = [];
  // Default: safety checks pass instantly. Set `h.autoMod.on = false` to answer them by hand.
  const autoMod = { on: true };
  const engine: Engine = new Engine(newRoomState('s1', 'Test'), {
    now: () => t,
    rng: mulberry32(seed),
    id: () => `id${++n}`,
    token: () => `tok${++n}`,
    requestLlm: (r) => llm.push(r),
    requestModeration: (r) => {
      mod.push(r);
      if (autoMod.on) engine.moderationResult(r.exchangeId, { kind: 'ok' });
    },
  });
  return {
    engine,
    llm,
    mod,
    autoMod,
    advance(ms: number) {
      t += ms;
      engine.tick();
    },
    now: () => t,
  };
}

/** Engine with one instructor and n joined groups. */
export function lobby(nGroups: number, seed = 1) {
  const h = makeEngine(seed);
  const inst = h.engine.loginInstructor('Ms. T');
  const groups = Array.from({ length: nGroups }, (_, i) => {
    const r = h.engine.joinGroup(`Group ${String.fromCharCode(65 + i)}`);
    if ('error' in r) throw new Error(r.error);
    return r.group;
  });
  return { ...h, inst, groups, I: { role: 'instructor' as const, id: inst.id } };
}
