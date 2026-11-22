// Projector view: timer, progress and class stats. Read-only; uses the instructor's saved token.
import type { DisplayView } from '../../shared/views';
import { load, useRoom } from './net';
import { StatsBundleView, Timer } from './ui';

// Short link and QR code (web/public/qr.png, made from this link) shown while the game waits to start.
const JOIN_LINK_TEXT = 'bit.ly/wai-spot-the-bot';

const TITLES: Record<string, string> = {
  lobby: 'Join the game!',
  round1_active: 'Round 1',
  round1_reveal: 'Round 1 results',
  round2_active: 'Round 2',
  round2_reveal: 'Round 2 results',
  ended: 'Final results',
};

function Leaderboard({ rows }: { rows: DisplayView['leaderboard'] }) {
  const two = rows.some((r) => r.r2 !== null);
  const f = (x: number) => (x > 0 ? `+${x.toFixed(2)}` : x.toFixed(2));
  return (
    <div class="card leaderboard">
      <h2>Leaderboard</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Group</th>
            <th>Round 1</th>
            {two && <th>Round 2</th>}
            {two && <th>Total</th>}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 10).map((r, i) => (
            <tr class={i === 0 ? 'first' : ''}>
              <td>{i + 1}</td>
              <td>{r.name}</td>
              <td>{f(r.r1)}</td>
              {two && <td>{r.r2 === null ? '–' : f(r.r2)}</td>}
              {two && <td><b>{f(r.total)}</b></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 10 && <p class="muted small">Top 10 of {rows.length} groups</p>}
    </div>
  );
}

export function DisplayApp({ sid }: { sid: string | null }) {
  const token = sid ? load<string>(`stb.inst.${sid}`) : null;
  const room = useRoom<DisplayView>(token ? sid : null, () => ({ t: 'display:rejoin', token: token! }), () => {}, () => {});
  if (!sid || !token) return <div class="screen center">Open this from the instructor dashboard (log in first).</div>;
  const v = room.view;
  if (!v) return <div class="screen center">Connecting…</div>;
  const active = v.phase === 'round1_active' || v.phase === 'round2_active';
  return (
    <div class="screen display">
      <h1>{TITLES[v.phase]}</h1>
      <div class="muted">{v.section}</div>
      {v.phase === 'lobby' && (
        <>
          <img class="join-qr" src={`${import.meta.env.BASE_URL}qr.png`} alt={`QR code for ${JOIN_LINK_TEXT}`} />
          <p class="join-link">{JOIN_LINK_TEXT}</p>
          <p class="display-big">
            {v.groupCount} group{v.groupCount === 1 ? '' : 's'} joined
          </p>
        </>
      )}
      {active && (
        <>
          <Timer v={v} offset={room.offset} big />
          <p class="display-big">{v.questionsThisRound} questions asked so far</p>
          {v.phase === 'round1_active' && <p class="muted">Interrogators: slide toward the answer you think is human.</p>}
        </>
      )}
      {v.leaderboard.length > 0 && <Leaderboard rows={v.leaderboard} />}
      {(v.stats.r1 || v.stats.r2) && !active && <StatsBundleView stats={v.stats} />}
    </div>
  );
}
