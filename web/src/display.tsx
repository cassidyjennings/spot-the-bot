// Projector view: timer, progress and class stats. Read-only; uses the instructor's saved token.
import type { DisplayView } from '../../shared/views';
import { load, useRoom } from './net';
import { StatsBundleView, Timer } from './ui';

const TITLES: Record<string, string> = {
  lobby: 'Join the game!',
  round1_active: 'Round 1',
  round1_reveal: 'Round 1 results',
  round2_active: 'Round 2',
  round2_reveal: 'Round 2 results',
  ended: 'Final results',
};

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
        <p class="display-big">
          {v.groupCount} group{v.groupCount === 1 ? '' : 's'} joined
          <br />
          <span class="muted">{location.origin + location.pathname}</span>
        </p>
      )}
      {active && (
        <>
          <Timer v={v} offset={room.offset} big />
          <p class="display-big">{v.questionsThisRound} questions asked so far</p>
          {v.phase === 'round1_active' && <p class="muted">Interrogators: slide toward the answer you think is human.</p>}
        </>
      )}
      {(v.stats.r1 || v.stats.r2) && !active && <StatsBundleView stats={v.stats} />}
    </div>
  );
}
