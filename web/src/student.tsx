// Student group screens (one phone per group).
import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_ANSWER, MAX_QUESTION } from '../../shared/types';
import type { GroupView, InterrogatorExchangeView, RevealExchangeView, RoundResultView } from '../../shared/views';
import { fetchSections, load, save, useRoom, type Room, type Section } from './net';
import { ConnBadge, GuessSlider, StatsBundleView, Timer, Toast, remainingMs, useNow } from './ui';

const KEY = 'stb.group';
interface Saved {
  sessionId: string;
  token: string;
}

export function StudentApp() {
  const [saved, setSaved] = useState<Saved | null>(() => load<Saved>(KEY));
  const [joinReq, setJoinReq] = useState<{ sessionId: string; password: string; name: string } | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const leaving = useRef(false); // our own Leave game triggers a "signed out" kick that shouldn't show as an error
  const sessionId = saved?.sessionId ?? joinReq?.sessionId ?? null;

  const room = useRoom<GroupView>(
    sessionId,
    () => (saved ? { t: 'group:rejoin', token: saved.token } : joinReq ? { t: 'group:join', password: joinReq.password, name: joinReq.name } : null),
    (token) => {
      const s = { sessionId: sessionId!, token };
      save(KEY, s);
      setSaved(s);
      setJoinReq(null);
    },
    (msg) => {
      save(KEY, null);
      setSaved(null);
      setJoinReq(null);
      setJoinError(leaving.current ? null : msg);
      leaving.current = false;
    },
  );

  if (!sessionId) return <Join error={joinError} onJoin={(r) => (setJoinError(null), setJoinReq(r))} />;
  const v = room.view;
  if (!v) return <div class="screen center"><p>Connecting…</p></div>;

  return (
    <div class="screen student">
      <ConnBadge connected={room.connected} />
      <header class="topbar">
        <div>
          <div class="group-name">{v.me.name}</div>
          <div class="muted small">{roleLabel(v)}</div>
        </div>
        <div class="topbar-right">
          <Timer v={v} offset={room.offset} />
          <button
            class="small leave"
            onClick={() => {
              if (!confirm('Leave the game? Your group can rejoin later with the same name and password.')) return;
              leaving.current = true;
              room.send({ t: 'group:leave' });
              setTimeout(() => {
                save(KEY, null);
                setSaved(null);
                leaving.current = false;
              }, 300);
            }}
          >
            Leave game
          </button>
        </div>
      </header>
      {v.pausedRemaining !== null && <div class="banner">Paused by the instructor</div>}
      <Body v={v} room={room} />
      <Toast msg={room.error} />
    </div>
  );
}

function roleLabel(v: GroupView) {
  switch (v.role) {
    case 'interrogator':
      return v.round === 1 ? 'Round 1 · You ask the questions' : 'Round 2 · You ask the questions';
    case 'responder':
      return `Round ${v.round} · You answer the questions`;
    case 'waiting':
      return 'Waiting for a match';
    case 'lobby':
      return 'In the lobby';
    default:
      return v.phase === 'ended' ? 'Final results' : `Round ${v.round} results`;
  }
}

function Body({ v, room }: { v: GroupView; room: Room<GroupView> }) {
  if (v.phase === 'lobby')
    return (
      <div class="center grow">
        <h2>You're in!</h2>
        <p>{v.groupCount} group{v.groupCount === 1 ? '' : 's'} joined. Waiting for the instructor to start.</p>
      </div>
    );
  if (v.role === 'waiting')
    return (
      <div class="center grow">
        <h2>Hang tight</h2>
        <p>This round already started. An instructor may match you now, or you'll play next round.</p>
      </div>
    );
  if (v.role === 'interrogator') return <Interrogator v={v} room={room} />;
  if (v.role === 'responder') return <Responder v={v} room={room} />;
  return <Results v={v} />;
}

// ---------------- Join ----------------

function Join({ error, onJoin }: { error: string | null; onJoin: (r: { sessionId: string; password: string; name: string }) => void }) {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    fetchSections()
      .then((s) => {
        setSections(s);
        if (s.length === 1) setSessionId(s[0].id);
      })
      .catch((e) => setLoadErr(e.message));
  }, []);

  return (
    <div class="screen center">
      <div class="join card">
        <h1>Spot the Bot</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (sessionId && password && name) onJoin({ sessionId, password: password.trim(), name: name.trim() });
          }}
        >
          <label>
            Your section
            <select value={sessionId} onChange={(e) => setSessionId((e.target as HTMLSelectElement).value)} required>
              <option value="">{sections ? 'Pick one…' : 'Loading…'}</option>
              {sections?.map((s) => <option value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            Session password
            <input value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} autocomplete="off" autocapitalize="off" required />
          </label>
          <label>
            Group name
            <input value={name} maxLength={20} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="e.g. The Turing Testers" required />
          </label>
          {(error || loadErr) && <p class="err">{error || loadErr}</p>}
          <button class="primary" type="submit">Join</button>
        </form>
        <p class="notice">Don't type your real name or any personal information. Questions are sent to an AI service.</p>
      </div>
    </div>
  );
}

// ---------------- Interrogator ----------------

function Interrogator({ v, room }: { v: GroupView; room: Room<GroupView> }) {
  const [q, setQ] = useState('');
  const now = useNow();
  const exs = v.interrogation ?? [];
  const pending = exs.some((e) => e.state === 'pending');
  const ms = remainingMs(v, room.offset, now);
  const timeUp = ms !== null && ms <= 0 && v.pausedRemaining === null;
  const paused = v.pausedRemaining !== null;
  const latest = exs[exs.length - 1];
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [exs.length, latest?.state]);

  return (
    <>
      <div class="history grow">
        {exs.length === 0 && (
          <div class="intro card">
            <p>
              Ask a question. You'll get <b>two answers</b>: one from another group of students, one from an AI.
            </p>
          </div>
        )}
        {exs.map((e) => (
          <ExchangeCard e={e} isLatest={e === latest} editable={e === latest} onGuess={(val) => room.send({ t: 'guess:update', exchangeId: e.id, v: val })} />
        ))}
        <div ref={endRef} />
      </div>
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim()) return;
          room.send({ t: 'question:submit', text: q });
          setQ('');
        }}
      >
        <textarea
          value={q}
          maxLength={MAX_QUESTION}
          rows={2}
          placeholder={timeUp ? "Time's up!" : pending ? 'Waiting for both answers…' : 'Ask a question…'}
          disabled={timeUp || paused}
          onInput={(e) => setQ((e.target as HTMLTextAreaElement).value)}
        />
        <div class="composer-row">
          <span class="muted small">{q.length}/{MAX_QUESTION}</span>
          <button class="primary" type="submit" disabled={timeUp || paused || pending || !q.trim()}>
            Ask
          </button>
        </div>
      </form>
    </>
  );
}

function ExchangeCard({ e, isLatest, editable, onGuess }: { e: InterrogatorExchangeView; isLatest: boolean; editable: boolean; onGuess: (v: number) => void }) {
  // Show the how-to only until the slider has been moved, and only on the newest released answer.
  const untouched = isLatest && e.slider === 0 && e.recordedGuess === null;
  const locked = !editable || e.recordedGuess !== null;
  return (
    <div class={`card exchange ${e.state}`}>
      <div class="q">
        <span class="qn">Q{e.idx}</span> {e.question}
      </div>
      {e.state === 'pending' && (
        <div class="muted waiting-dots">{e.retry ? 'Just a few more seconds' : 'Waiting for both answers'}</div>
      )}
      {e.state === 'blocked' && <div class="warn">That question isn't allowed. Ask something else.</div>}
      {e.state === 'void' && <div class="warn">Technical issue. Ask another question.</div>}
      {e.state === 'released' && (
        <>
          <div class="answers">
            <div class="answer">
              <div class="side">Left</div>
              {e.left}
            </div>
            <div class="answer">
              <div class="side">Right</div>
              {e.right}
            </div>
          </div>
          {untouched && (
            <div class="hint">
              Which answer is the <b>human</b>? Slide toward it. The more confident you are, the further you slide.
            </div>
          )}
          <GuessSlider value={e.slider} ghost={null} onChange={onGuess} disabled={locked} pulse={untouched} />
          {(!isLatest || e.recordedGuess !== null) && <div class="muted small">Locked in.</div>}
        </>
      )}
    </div>
  );
}

// ---------------- Responder ----------------

function Responder({ v, room }: { v: GroupView; room: Room<GroupView> }) {
  const [a, setA] = useState('');
  const items = v.responding ?? [];
  const open = items.find((e) => !e.answered);
  const done = items.filter((e) => e.answered).reverse();
  useEffect(() => setA(''), [open?.id]);

  return (
    <div class="grow">
      <div class="card intro">
        {v.opponent === 'instructor' ? (
          <>
            An instructor is asking you questions. Your answers appear next to an AI's answer.{' '}
            <b>Convince them you're the human.</b>
          </>
        ) : (
          <>
            Your answers appear next to an AI's answer. <b>Convince the other group you're the human.</b>
          </>
        )}
      </div>
      {open ? (
        <form
          class="card incoming"
          onSubmit={(e) => {
            e.preventDefault();
            if (a.trim()) room.send({ t: 'answer:submit', exchangeId: open.id, text: a });
          }}
        >
          <div class="muted small">Question {open.idx}</div>
          <div class="q big">{open.question}</div>
          {open.redo && <div class="warn">That answer wasn't allowed. Please write a different one.</div>}
          <textarea value={a} maxLength={MAX_ANSWER} rows={3} placeholder="Your group's answer…" onInput={(e) => setA((e.target as HTMLTextAreaElement).value)} />
          <button class="primary" type="submit" disabled={!a.trim()}>
            Send answer
          </button>
        </form>
      ) : (
        <div class="card center muted waiting-dots">Waiting for the next question</div>
      )}
      {done.length > 0 && (
        <div class="history">
          {done.map((e) => (
            <div class="card exchange">
              <div class="q">
                <span class="qn">Q{e.idx}</span> {e.question}
              </div>
              <div class="mine">You: {e.myAnswer}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Reveal / final ----------------

function Results({ v }: { v: GroupView }) {
  const results = v.results ?? [];
  const final = v.phase === 'ended';
  const shown = final ? results : results.slice(-1);
  return (
    <div class="grow results">
      <div class="card score-card">
        {final || v.phase === 'round2_reveal' ? (
          <>
            <div class="muted">Total score</div>
            <div class="score">{fmtScore(v.totalScore ?? 0)}</div>
            <div class="muted small">{results.map((r) => `Round ${r.round}: ${fmtScore(r.score)}`).join(' · ')}</div>
          </>
        ) : (
          <>
            <div class="muted">Round {shown[0]?.round} score</div>
            <div class="score">{fmtScore(shown[0]?.score ?? 0)}</div>
            <div class="muted small">Get ready to swap roles for Round 2!</div>
          </>
        )}
      </div>
      {shown.map((r) => <RoundTranscript r={r} />)}
      {final && v.stats && (
        <>
          <h2>The whole class</h2>
          <StatsBundleView stats={v.stats} />
        </>
      )}
    </div>
  );
}

const fmtScore = (x: number) => (x > 0 ? `+${x.toFixed(2)}` : x.toFixed(2));

function RoundTranscript({ r }: { r: RoundResultView }) {
  const other = r.opponent === 'instructor' ? 'an instructor' : 'the other group';
  return (
    <div class="transcript">
      <h3>
        Round {r.round}:{' '}
        {r.role === 'interrogator' ? `you questioned ${other} and the AI` : 'how the interrogators judged your answers'}
      </h3>
      {r.exchanges.map((e) => <RevealCard e={e} role={r.role} />)}
      {r.exchanges.length === 0 && <p class="muted">No questions this round.</p>}
    </div>
  );
}

function RevealCard({ e, role }: { e: RevealExchangeView; role: 'interrogator' | 'responder' }) {
  if (e.state !== 'released')
    return (
      <div class="card exchange muted">
        <span class="qn">Q{e.idx}</span> {e.question} <em>({e.state === 'blocked' ? 'blocked' : 'not answered'})</em>
      </div>
    );
  const label = (side: 'left' | 'right') => (e.humanSide === side ? 'Human' : 'AI');
  // Both groups in a match are on the same team: s > 0 means the interrogator spotted the human.
  const s = e.s ?? 0;
  const verdict =
    s === 0 ? 'No guess' : role === 'interrogator' ? (s > 0 ? 'Correct' : 'Fooled') : s > 0 ? 'They spotted you' : 'The AI fooled them';
  const good = s > 0;
  return (
    <div class="card exchange">
      <div class="q">
        <span class="qn">Q{e.idx}</span> {e.question}
      </div>
      <div class="answers">
        {(['left', 'right'] as const).map((side) => (
          <div class={`answer ${e.humanSide === side ? 'human' : 'ai'}`}>
            <div class="side">
              {side === 'left' ? 'Left' : 'Right'} · <b>{label(side)}</b>
            </div>
            {side === 'left' ? e.left : e.right}
          </div>
        ))}
      </div>
      <GuessSlider value={e.recordedGuess ?? 0} ghost={e.recordedGuess} disabled />
      <div class={`verdict ${s === 0 ? '' : good ? 'good' : 'bad'}`}>
        {verdict} {s !== 0 && <span class="muted">({fmtScore(s)})</span>}
      </div>
    </div>
  );
}
