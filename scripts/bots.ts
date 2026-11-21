// Bot simulator: N fake groups join a section, ask, answer and move sliders at random speeds.
// With --drive, a bot instructor also runs the whole game (both rounds) and prints a summary.
//
//   npx tsx scripts/bots.ts --n 7 --password alpha --drive --round-min 0.5
//   npx tsx scripts/bots.ts --url wss://spot-the-bot.<you>.workers.dev --session s2 --password bravo --n 9
import type { GroupView, InstructorView } from '../shared/views';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);
const URL_BASE = (args.url ?? 'ws://127.0.0.1:8787').replace(/\/$/, '');
const SESSION = args.session ?? 's1';
const ORIGIN = args.origin ?? 'https://cassidyjennings.github.io';
const N = Number(args.n ?? 5);
const PASSWORD = args.password ?? 'alpha';
const DRIVE = args.drive === 'true';
const INSTRUCTOR_PW = args['instructor-password'] ?? 'teach';
const ROUND_MIN = Number(args['round-min'] ?? 0.5);
const SPEED = Number(args.speed ?? 1); // >1 = faster bots

const QUESTIONS = [
  "what's your favorite food?", 'what did you have for breakfast?', 'whats 17 times 23', 'do you like school?',
  'describe your room', 'favorite movie and why', 'what would you do with a million dollars',
  "what's the weather like where you are right now", 'tell me a joke', 'cats or dogs?',
];
const ANSWERS = ['uhh pizza', 'idk lol', 'probably cats', 'that is hard to say', 'my room is a mess tbh', 'no comment haha'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const delay = (lo: number, hi: number) => (lo + Math.random() * (hi - lo)) / SPEED;

let errors = 0;
const unexpected: string[] = [];
const EXPECTED = [/no longer open/, /Time's up/, /Wait for both/, /No round is running/, /That round is over/];

function connect(onMsg: (m: any, ws: WebSocket) => void, first: object, label: string): WebSocket {
  // The deployed worker rejects connections with no Origin header (ALLOWED_ORIGINS), and Node sends none.
  // Node's built-in WebSocket accepts a headers option as its second argument.
  const ws = new (WebSocket as any)(`${URL_BASE}/ws?session=${SESSION}`, { headers: { Origin: ORIGIN } }) as WebSocket;
  ws.addEventListener('open', () => ws.send(JSON.stringify(first)));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === 'error') {
      errors++;
      if (!EXPECTED.some((r) => r.test(m.msg))) unexpected.push(`${label}: ${m.msg}`);
    }
    onMsg(m, ws);
  });
  ws.addEventListener('error', () => {
    unexpected.push(`${label}: socket error`);
    // A refused connection (wrong URL, or an Origin the server rejects) would otherwise exit silently.
    console.error(`${label}: connection failed (check --url, --origin, and that the worker is deployed)`);
  });
  return ws;
}

function bot(k: number) {
  const name = `Bot ${k} ${Math.random().toString(36).slice(2, 5)}`;
  const scheduled = new Set<string>();
  let asking = false;
  const ws = connect(
    (m, ws) => {
      if (m.t !== 'snapshot') return;
      const v = m.view as GroupView;
      const live = v.roundEndsAt !== null && v.pausedRemaining === null && v.serverNow < v.roundEndsAt;
      if (v.role === 'interrogator' && v.interrogation) {
        for (const e of v.interrogation) {
          if (e.state === 'released' && e.recordedGuess === null && !scheduled.has(e.id)) {
            scheduled.add(e.id);
            setTimeout(() => ws.send(JSON.stringify({ t: 'guess:update', exchangeId: e.id, v: Math.round((Math.random() * 2 - 1) * 100) / 100 })), delay(500, 2500));
          }
        }
        const pending = v.interrogation.some((e) => e.state === 'pending');
        if (!pending && live && !asking) {
          asking = true;
          setTimeout(() => {
            asking = false;
            ws.send(JSON.stringify({ t: 'question:submit', text: pick(QUESTIONS) }));
          }, delay(3000, 8000));
        }
      }
      if (v.role === 'responder' && v.responding) {
        for (const e of v.responding) {
          if (!e.answered && !scheduled.has(e.id)) {
            scheduled.add(e.id);
            setTimeout(() => ws.send(JSON.stringify({ t: 'answer:submit', exchangeId: e.id, text: pick(ANSWERS) })), delay(2000, 7000));
          }
        }
      }
    },
    { t: 'group:join', password: PASSWORD, name },
    name,
  );
  setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 15_000).unref();
  return ws;
}

const sockets = Array.from({ length: N }, (_, i) => bot(i + 1));
console.log(`${N} bots joining ${URL_BASE} session ${SESSION}`);

if (DRIVE) {
  let lastPhase = '';
  const inst = connect(
    (m, ws) => {
      if (m.t === 'auth') {
        ws.send(JSON.stringify({ t: 'config:set', roundMinutes: ROUND_MIN }));
        setTimeout(() => ws.send(JSON.stringify({ t: 'round:start' })), 2000); // let bots join
        return;
      }
      if (m.t !== 'snapshot') return;
      const v = m.view as InstructorView;
      if (v.phase === lastPhase) return;
      lastPhase = v.phase;
      console.log(`[${new Date().toLocaleTimeString()}] phase -> ${v.phase} (${v.groups.length} groups, ${v.matches.filter((x) => x.round === v.round).length} matches)`);
      if (v.phase === 'round1_reveal') setTimeout(() => ws.send(JSON.stringify({ t: 'round:start' })), 3000);
      if (v.phase === 'round2_reveal') setTimeout(() => ws.send(JSON.stringify({ t: 'game:end' })), 1000);
      if (v.phase === 'ended') {
        const all = v.stats.all!;
        const exs = v.matches.flatMap((x) => x.exchanges);
        const totals = Object.values(v.scores).reduce((a, s) => a + s.r1 + s.r2, 0);
        console.log('--- summary ---');
        console.log(`exchanges: ${exs.length} (released ${exs.filter((e) => e.state === 'released').length}, void ${exs.filter((e) => e.state === 'void').length}, blocked ${exs.filter((e) => e.state === 'blocked').length})`);
        const byInstructor = v.matches.filter((x) => x.interrogatorType === 'instructor').flatMap((x) => x.exchanges);
        console.log(`instructor-asked exchanges: ${byInstructor.length} (released ${byInstructor.filter((e) => e.state === 'released').length})`);
        console.log(`scored ${all.scored}, correct ${pct(all.pctCorrect)}, LLM judged human ${pct(all.pctLlmJudgedHuman)}`);
        console.log(`sum of group scores (non-zero only from instructor matches): ${totals.toFixed(2)}`);
        console.log(`errors: ${errors} total, unexpected: ${unexpected.length}`);
        unexpected.slice(0, 10).forEach((u) => console.log('  ' + u));
        ws.send(JSON.stringify({ t: 'session:reset' }));
        setTimeout(() => {
          sockets.forEach((s) => s.close());
          ws.close();
          process.exit(unexpected.length ? 1 : 0);
        }, 500);
      }
    },
    { t: 'instructor:login', password: INSTRUCTOR_PW, name: 'Bot instructor' },
    'instructor',
  );
  // The bot instructor answers questions in instructor-responder matches, and asks + judges in
  // instructor-interrogator matches (the odd group's answering turn).
  const answered = new Set<string>();
  const scheduledIq = new Set<string>();
  const askingNow = new Set<string>();
  inst.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t !== 'snapshot') return;
    const iv = m.view as InstructorView;
    const live = iv.roundEndsAt !== null && iv.pausedRemaining === null && iv.serverNow < iv.roundEndsAt;
    for (const match of iv.matches) {
      if (match.round !== iv.round || match.interrogatorType !== 'instructor' || match.instructorId !== iv.me.id) continue;
      const last = match.exchanges[match.exchanges.length - 1];
      if (last?.state === 'released' && last.recordedGuess === null && !scheduledIq.has(last.id)) {
        scheduledIq.add(last.id);
        setTimeout(() => inst.send(JSON.stringify({ t: 'iguess:update', exchangeId: last.id, v: Math.round((Math.random() * 2 - 1) * 100) / 100 })), delay(500, 2500));
      }
      if (last?.state !== 'pending' && live && !askingNow.has(match.id)) {
        askingNow.add(match.id);
        setTimeout(() => {
          askingNow.delete(match.id);
          inst.send(JSON.stringify({ t: 'iq:submit', matchId: match.id, text: pick(QUESTIONS) }));
        }, delay(3000, 8000));
      }
    }
    for (const match of iv.matches) {
      if (match.responderType !== 'instructor') continue;
      for (const e of match.exchanges) {
        if (e.state === 'pending' && e.humanText === undefined && !answered.has(e.id)) {
          answered.add(e.id);
          setTimeout(() => inst.send(JSON.stringify({ t: 'answer:submit', exchangeId: e.id, text: pick(ANSWERS) })), delay(2000, 5000));
        }
      }
    }
  });
}

function pct(x: number | null) {
  return x === null ? '-' : `${Math.round(x * 100)}%`;
}
