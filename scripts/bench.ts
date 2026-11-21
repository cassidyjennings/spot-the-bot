// CPU micro-benchmark for one section's server work. No network and no Gemini calls.
//   npx tsx scripts/bench.ts [--n 16,32,64] [--exchanges 6]
// Builds a busy mid-round state with N groups, then times what GameRoom does per event:
//   full commit  = serialize the state + build and serialize a view for every phone + instructor + projector
//   slider event = state not serialized + views for the dragging group and the instructor only
import { Engine } from '../shared/engine';
import { newRoomState } from '../shared/types';
import { displayView, groupView, instructorView } from '../shared/views';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const sizes = arg('n', '16,32,64,96,128').split(',').map(Number);
const perMatch = Number(arg('exchanges', '6'));

function build(n: number) {
  let t = 1_000_000;
  let c = 0;
  let engine!: Engine;
  engine = new Engine(newRoomState('s1', 'Bench'), {
    now: () => t,
    rng: Math.random,
    id: () => `id${(++c).toString(36)}`,
    token: () => `tok${(++c).toString(36)}`,
    requestLlm: (r) => engine.llmResult(r.exchangeId, { kind: 'ok', text: 'idk honestly probably pizza' }),
    requestModeration: (r) => engine.moderationResult(r.exchangeId, { kind: 'ok' }),
  });
  const inst = engine.loginInstructor('Ms. T');
  const I = { role: 'instructor' as const, id: inst.id };
  const groups = Array.from({ length: n }, (_, i) => {
    const r = engine.joinGroup(`Group ${i + 1}`);
    if ('error' in r) throw new Error(r.error);
    return r.group;
  });
  engine.handle(I, { t: 'round:start' });
  for (let k = 0; k < perMatch; k++) {
    for (const m of engine.currentMatches()) {
      engine.handle({ role: 'group', id: m.interrogatorId }, { t: 'question:submit', text: `what is your favorite thing number ${k}?` });
      const ex = engine.s.exchanges.filter((e) => e.matchId === m.id).at(-1)!;
      if (m.responderType === 'group') {
        engine.handle({ role: 'group', id: m.responderGroupId! }, { t: 'answer:submit', exchangeId: ex.id, text: 'probably pizza ngl, its just good' });
      } else {
        engine.handle(I, { t: 'answer:submit', exchangeId: ex.id, text: 'pizza' });
      }
      engine.handle({ role: 'group', id: m.interrogatorId }, { t: 'guess:update', exchangeId: ex.id, v: 0.4 });
    }
    t += 20_000;
  }
  return { engine, inst, groups, now: () => t };
}

function time(fn: () => void, reps: number) {
  for (let i = 0; i < 3; i++) fn(); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

console.log('groups  exchanges  state KB  full commit ms  slider event ms');
for (const n of sizes) {
  const { engine, inst, groups, now } = build(n);
  const s = engine.s;
  const kb = JSON.stringify(s).length / 1024;
  const full = time(() => {
    JSON.stringify(s);
    for (const g of groups) JSON.stringify(groupView(s, g.id, now()));
    JSON.stringify(instructorView(s, inst.id, now()));
    JSON.stringify(displayView(s, now()));
  }, 50);
  const slider = time(() => {
    JSON.stringify(groupView(s, groups[0].id, now()));
    JSON.stringify(instructorView(s, inst.id, now()));
  }, 200);
  console.log(
    `${String(n).padStart(6)}  ${String(s.exchanges.length).padStart(9)}  ${kb.toFixed(0).padStart(8)}  ${full.toFixed(2).padStart(14)}  ${slider.toFixed(2).padStart(15)}`,
  );
}
