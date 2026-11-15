// Instructor dashboard (laptop).
import { useEffect, useState } from 'preact/hooks';
import { MAX_ANSWER, STALE_MS } from '../../shared/types';
import type { InstructorMatchView, InstructorView } from '../../shared/views';
import { fetchSections, load, save, useRoom, type Room, type Section } from './net';
import { ConnBadge, StatsBundleView, Timer, Toast, remainingMs, useNow } from './ui';

const tokenKey = (sid: string) => `stb.inst.${sid}`;
const CREDS = 'stb.instCreds'; // sessionStorage only: cleared when the tab closes
interface Creds {
  password: string;
  name: string;
}

export function InstructorApp() {
  const [sections, setSections] = useState<Section[]>([]);
  const [sid, setSid] = useState<string | null>(() => load<string>('stb.instSection'));
  const [creds, setCreds] = useState<Creds | null>(() => load<Creds>(CREDS, sessionStorage));
  const [loginErr, setLoginErr] = useState<string | null>(null);
  useEffect(() => {
    fetchSections().then(setSections).catch((e) => setLoginErr(e.message));
  }, []);

  const token = sid ? load<string>(tokenKey(sid)) : null;
  const canConnect = !!sid && (!!token || !!creds);
  const room = useRoom<InstructorView>(
    canConnect ? sid : null,
    () => {
      const t = sid ? load<string>(tokenKey(sid)) : null;
      if (t) return { t: 'instructor:rejoin', token: t };
      return creds ? { t: 'instructor:login', password: creds.password, name: creds.name } : null;
    },
    (t) => save(tokenKey(sid!), t),
    (msg) => {
      save(tokenKey(sid!), null);
      if (/password/i.test(msg)) {
        save(CREDS, null, sessionStorage);
        setCreds(null);
      }
      setLoginErr(msg);
      setSid(null);
    },
  );

  const pick = (id: string) => {
    save('stb.instSection', id);
    setSid(id);
  };

  if (!canConnect)
    return (
      <Login
        sections={sections}
        error={loginErr}
        initial={sid}
        onLogin={(id, c) => {
          setLoginErr(null);
          save(CREDS, c, sessionStorage);
          setCreds(c);
          pick(id);
        }}
      />
    );
  const v = room.view;
  if (!v) return <div class="screen center">Connecting…</div>;
  return (
    <Dashboard
      v={v}
      room={room}
      sections={sections}
      sid={sid!}
      onSwitch={(id) => (creds ? pick(id) : (setSid(null), setLoginErr('Log in to switch sections.')))}
    />
  );
}

function Login({ sections, error, initial, onLogin }: { sections: Section[]; error: string | null; initial: string | null; onLogin: (sid: string, c: Creds) => void }) {
  const [sid, setSid] = useState(initial ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  return (
    <div class="screen center">
      <form
        class="card join"
        onSubmit={(e) => {
          e.preventDefault();
          if (sid && password && name) onLogin(sid, { password, name: name.trim() });
        }}
      >
        <h1>Instructor login</h1>
        <label>
          Section
          <select value={sid} onChange={(e) => setSid((e.target as HTMLSelectElement).value)} required>
            <option value="">Pick one…</option>
            {sections.map((s) => <option value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>
          Instructor password
          <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          Your display name
          <input value={name} maxLength={30} onInput={(e) => setName((e.target as HTMLInputElement).value)} required />
        </label>
        {error && <p class="err">{error}</p>}
        <button class="primary" type="submit">Log in</button>
      </form>
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Lobby',
  round1_active: 'Round 1',
  round1_reveal: 'Round 1 reveal',
  round2_active: 'Round 2',
  round2_reveal: 'Round 2 reveal',
  ended: 'Game over',
};

function Dashboard({ v, room, sections, sid, onSwitch }: { v: InstructorView; room: Room<InstructorView>; sections: Section[]; sid: string; onSwitch: (id: string) => void }) {
  const send = room.send;
  const now = useNow(1000);
  const serverNow = now + room.offset;
  const active = v.phase === 'round1_active' || v.phase === 'round2_active';
  const ms = remainingMs(v, room.offset, now);
  const timerDone = active && ms !== null && ms <= 0 && v.pausedRemaining === null;
  const current = v.matches.filter((m) => m.round === v.round);
  const groupName = (id: string) => v.groups.find((g) => g.id === id)?.name ?? '?';
  const stale = (g: { connected: boolean; lastSeen: number }) => !g.connected || serverNow - g.lastSeen > STALE_MS;
  const [minutes, setMinutes] = useState(String(v.config.roundMs / 60000));
  const [tab, setTab] = useState<'matches' | 'groups' | 'stats'>('matches');
  const hasStats = !!(v.stats.r1 || v.stats.r2);

  const confirmSend = (text: string, m: Parameters<typeof send>[0]) => {
    if (confirm(text)) send(m);
  };

  return (
    <div class="screen dash">
      <ConnBadge connected={room.connected} />
      <div class="dash-brand">
        <h1>Spot the Bot</h1>
        <span class="muted">Instructor dashboard</span>
      </div>
      <header class="dash-top">
        <div class="dash-title">
          <select value={sid} onChange={(e) => onSwitch((e.target as HTMLSelectElement).value)} aria-label="Section">
            {sections.map((s) => <option value={s.id}>{s.name}</option>)}
          </select>
          <span class="phase-chip">{PHASE_LABEL[v.phase]}</span>
          <span class="muted small">{v.groups.filter((g) => !g.removed).length} groups · you are {v.me.name}</span>
        </div>
        <Timer v={v} offset={room.offset} />
        <div class="controls">
          {v.phase === 'lobby' && (
            <>
              <label class="inline">
                Round length (min)
                <input type="number" min={0.25} max={30} step={0.25} value={minutes} onInput={(e) => setMinutes((e.target as HTMLInputElement).value)} style={{ width: '5em' }} />
              </label>
              <button onClick={() => send({ t: 'config:set', roundMinutes: Number(minutes) })}>Set</button>
              <button class="primary" onClick={() => send({ t: 'round:start' })}>Start Round 1</button>
            </>
          )}
          {active && (
            <>
              {v.pausedRemaining === null ? (
                <button onClick={() => send({ t: 'timer:pause' })} disabled={timerDone}>Pause</button>
              ) : (
                <button class="primary" onClick={() => send({ t: 'timer:resume' })}>Resume</button>
              )}
              <button onClick={() => send({ t: 'timer:adjust', deltaMs: 60_000 })}>+1 min</button>
              {!timerDone && <button onClick={() => confirmSend('End the round now? Pending questions get the 60 s grace period.', { t: 'round:end' })}>End round early</button>}
              {timerDone && <button class="primary" onClick={() => send({ t: 'round:reveal' })}>Reveal now</button>}
            </>
          )}
          {v.phase === 'round1_reveal' && (
            <>
              <label class="inline">
                Round 2 length (min)
                <input type="number" min={0.25} max={30} step={0.25} value={minutes} onInput={(e) => setMinutes((e.target as HTMLInputElement).value)} style={{ width: '5em' }} />
              </label>
              <button onClick={() => send({ t: 'config:set', roundMinutes: Number(minutes) })}>Set</button>
              <button class="primary" onClick={() => send({ t: 'round:start' })}>Start Round 2 (swap roles)</button>
            </>
          )}
          {v.phase === 'round2_reveal' && <button class="primary" onClick={() => send({ t: 'game:end' })}>End game · show final</button>}
          <a class="button" href={`#/display?s=${sid}`} target="_blank" rel="noopener">Projector view</a>
        </div>
      </header>

      {v.llm.rateLimited && <div class="banner warn">AI is rate-limited: answers are delayed. Retrying automatically.</div>}
      {v.llm.queued > 3 && <div class="banner warn">AI queue backing up ({v.llm.queued} waiting).</div>}
      {v.alerts.length > 0 && (
        <div class="card alerts">
          <div class="row-between">
            <b>Alerts</b>
            <button class="link" onClick={() => send({ t: 'alerts:clear' })}>clear</button>
          </div>
          {v.alerts.slice(0, 5).map((a) => (
            <div class="small">
              {new Date(a.at).toLocaleTimeString()} · {a.text}
            </div>
          ))}
        </div>
      )}

      <MyQueue v={v} room={room} />

      <div class="dash-grid">
        <section class="panel">
          <div class="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'matches'} class={tab === 'matches' ? 'on' : ''} onClick={() => setTab('matches')}>
              Matches {current.length > 0 && <span class="count">{current.length}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'groups'} class={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>
              Groups <span class="count">{v.groups.filter((g) => !g.removed).length}</span>
            </button>
            {hasStats && (
              <button role="tab" aria-selected={tab === 'stats'} class={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>
                Class stats
              </button>
            )}
          </div>

          {tab === 'matches' && (
            <div class="stack">
              {current.length === 0 && <p class="muted">Matches appear when a round starts.</p>}
              {current.map((m) => (
                <MatchCard m={m} v={v} send={send} stale={m.responderGroupId ? stale(v.groups.find((g) => g.id === m.responderGroupId)!) : false} />
              ))}
            </div>
          )}

          {tab === 'groups' && (
            <div class="stack">
              {v.groups
                .filter((g) => !g.removed)
                .map((g) => (
                  <div class="group-row">
                    <div class="group-main">
                      <span class={`dot ${g.released ? 'off' : stale(g) ? 'warn' : 'ok'}`} title={g.released ? 'name released' : stale(g) ? 'no heartbeat' : 'connected'} />
                      <b>{g.name}</b>
                      {v.phase !== 'lobby' && <span class="muted small">R1 {v.scores[g.id]?.r1 ?? 0} · R2 {v.scores[g.id]?.r2 ?? 0}</span>}
                    </div>
                    <div class="actions">
                      {v.waitingGroupIds.includes(g.id) && (
                        <button class="small primary" onClick={() => send({ t: 'late:match', groupId: g.id })}>Match with me</button>
                      )}
                      <button class="small" title="Lets a group that lost its phone rejoin with the same name" onClick={() => confirmSend(`Release "${g.name}"? Its current phone will be signed out; the group can rejoin with the same name.`, { t: 'group:release', groupId: g.id })}>
                        Release name
                      </button>
                      <button class="small danger" onClick={() => confirmSend(`Remove "${g.name}" from the game?`, { t: 'group:remove', groupId: g.id })}>Remove</button>
                    </div>
                  </div>
                ))}
              {v.groups.filter((g) => !g.removed).length === 0 && <p class="muted">No groups yet.</p>}
              {v.waitingGroupIds.length > 0 && <p class="small muted">Groups with "Match with me" joined late. Leave them unmatched and they'll play an instructor in Round 2.</p>}
            </div>
          )}

          {tab === 'stats' && hasStats && <StatsBundleView stats={v.stats} />}
        </section>

        <section class="panel">
          <h2 class="panel-title">Question feed</h2>
          <Feed matches={current} send={send} groupName={groupName} canBlock={active} />
        </section>
      </div>

      <details class="dash-foot">
        <summary>Session options</summary>
        <div class="dash-foot-actions">
        <button onClick={() => confirmSend('Reset this section back to an empty lobby? All groups and scores are cleared.', { t: 'session:reset' })}>Reset session</button>
        <button class="danger" onClick={() => confirmSend('Permanently delete all data for this section (groups, questions, answers)? This cannot be undone.', { t: 'session:delete' })}>
          Delete session data
        </button>
        </div>
      </details>
      <Toast msg={room.error} />
    </div>
  );
}

function MatchCard({ m, v, send, stale }: { m: InstructorMatchView; v: InstructorView; send: Room<InstructorView>['send']; stale: boolean }) {
  const mine = m.instructorId === v.me.id;
  const active = v.phase === 'round1_active' || v.phase === 'round2_active';
  return (
    <div class={`card match ${stale && active ? 'alert' : ''}`}>
      <div class="match-head">
        <div class="match-names">
          <b>{m.interrogatorName}</b>
          <span class="arrow">asks</span>
          <span>{m.responderName}</span>
        </div>
        <span class={`chip status ${m.status.replace(/\s+/g, '-')}`}>{m.status}</span>
      </div>
      <div class="match-meta small muted">
        {m.exchanges.filter((e) => e.state === 'released').length} answered · {m.exchanges.length} asked
        {m.oddGroup && <span class="chip">odd group</span>}
        {m.late && <span class="chip">late</span>}
      </div>
      {stale && active && <div class="small warn">Responder group has no heartbeat for 45 s+</div>}
      {m.takenOverBy && <div class="small">Taken over by {v.instructors.find((i) => i.id === m.takenOverBy)?.name}</div>}
      <div class="actions match-actions">
        {m.responderType === 'group' &&
          active &&
          (m.takenOverBy ? (
            <button class="small" onClick={() => send({ t: 'match:untakeover', matchId: m.id })}>Give back to group</button>
          ) : (
            <button class="small" onClick={() => send({ t: 'match:takeover', matchId: m.id })}>Take over</button>
          ))}
        {m.responderType === 'instructor' && !mine && active && (
          <button class="small" onClick={() => send({ t: 'match:claim', matchId: m.id })}>Claim (answer as me)</button>
        )}
      </div>
    </div>
  );
}

function MyQueue({ v, room }: { v: InstructorView; room: Room<InstructorView> }) {
  const mineMatches = v.matches.filter(
    (m) => m.round === v.round && ((m.responderType === 'instructor' && m.instructorId === v.me.id) || m.takenOverBy === v.me.id),
  );
  const unassigned = v.matches.filter((m) => m.round === v.round && m.responderType === 'instructor' && !m.instructorId);
  const queue = mineMatches.flatMap((m) =>
    m.exchanges.filter((e) => e.state === 'pending' && e.humanText === undefined).map((e) => ({ e, m })),
  );
  if (!mineMatches.length && !unassigned.length) return null;
  return (
    <div class="card queue">
      <h2 class="panel-title">You answer ({queue.length} waiting)</h2>
      {unassigned.length > 0 && <p class="warn small">{unassigned.length} instructor match(es) have no instructor. Claim them in Matches.</p>}
      {queue.length === 0 && <p class="muted small">No questions waiting. Your matches: {mineMatches.map((m) => m.interrogatorName).join(', ')}</p>}
      {queue.map(({ e, m }) => (
        <AnswerBox key={e.id} label={`${m.interrogatorName} · Q${e.idx}`} question={e.question} onSend={(text) => room.send({ t: 'answer:submit', exchangeId: e.id, text })} />
      ))}
    </div>
  );
}

function AnswerBox({ label, question, onSend }: { label: string; question: string; onSend: (t: string) => void }) {
  const [a, setA] = useState('');
  return (
    <form
      class="answer-box"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (a.trim()) onSend(a);
      }}
    >
      <div class="small muted">{label}</div>
      <div class="q">{question}</div>
      <textarea rows={2} maxLength={MAX_ANSWER} value={a} placeholder="Answer like a teenager would…" onInput={(e) => setA((e.target as HTMLTextAreaElement).value)} />
      <button class="primary small" type="submit" disabled={!a.trim()}>Send</button>
    </form>
  );
}

function Feed({ matches, send, groupName, canBlock }: { matches: InstructorMatchView[]; send: Room<InstructorView>['send']; groupName: (id: string) => string; canBlock: boolean }) {
  const items = matches
    .flatMap((m) => m.exchanges.map((e) => ({ e, m })))
    .sort((a, b) => b.e.createdAt - a.e.createdAt);
  if (!items.length) return <p class="muted">No questions yet.</p>;
  return (
    <div class="feed">
      {items.map(({ e, m }) => (
        <div class={`card feed-item ${e.flags.length ? 'flagged' : ''} ${e.state}`}>
          <div class="row-between small muted">
            <span>
              {new Date(e.createdAt).toLocaleTimeString()} · {groupName(m.interrogatorId)}
            </span>
            <span class={`chip status ${e.state}`}>{e.state}{e.blockedBy === 'llm' ? ' (AI)' : ''}</span>
          </div>
          <div class="q">
            <Highlight text={e.question} terms={e.flags} />
          </div>
          {(e.humanText || e.llmText) && (
            <details class="feed-answers small">
              <summary>Show answers</summary>
              {e.humanText && <div><b>Human:</b> {e.humanText}</div>}
              {e.llmText && <div><b>AI:</b> {e.llmText}</div>}
            </details>
          )}
          {canBlock && (e.state === 'pending' || e.state === 'released') && (
            // The feed grows at the top while you aim, so confirm which question is being blocked.
            <button class="small danger" onClick={() => confirm(`Block this question?\n\n"${e.question}"`) && send({ t: 'exchange:block', exchangeId: e.id })}>
              Block
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  // Flags come from a normalized match, so highlight the whole question when we can't locate the term.
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  const parts = text.split(re);
  return parts.length > 1 ? <>{parts.map((p, i) => (i % 2 ? <mark>{p}</mark> : p))}</> : <mark>{text}</mark>;
}
