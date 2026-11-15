import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClassStats } from '../../shared/scoring';
import type { StatsBundle } from '../../shared/views';

export function useNow(intervalMs = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

interface ClockLike {
  roundEndsAt: number | null;
  pausedRemaining: number | null;
  graceEndsAt: number | null;
}

export function remainingMs(v: ClockLike, offset: number, now: number): number | null {
  if (v.pausedRemaining !== null) return v.pausedRemaining;
  if (v.roundEndsAt === null) return null;
  return Math.max(0, v.roundEndsAt - (now + offset));
}

export const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Timer({ v, offset, big }: { v: ClockLike; offset: number; big?: boolean }) {
  const now = useNow();
  const ms = remainingMs(v, offset, now);
  if (ms === null) return null;
  const paused = v.pausedRemaining !== null;
  const ended = ms <= 0 && !paused;
  return (
    <div class={`timer ${big ? 'big' : ''} ${ms < 30_000 && !paused ? 'low' : ''}`} aria-live="off">
      {paused ? `Paused ${fmt(ms)}` : ended ? "Time's up" : fmt(ms)}
    </div>
  );
}

/**
 * -1 = left is human, +1 = right is human. Keeps a local value while dragging and sends
 * throttled updates; `ghost` marks the value that was recorded for scoring.
 */
export function GuessSlider({
  value,
  ghost,
  onChange,
  disabled,
  pulse,
}: {
  value: number;
  ghost: number | null;
  onChange?: (v: number) => void;
  disabled?: boolean;
  pulse?: boolean;
}) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  const push = (v: number, force = false) => {
    if (!onChange) return;
    clearTimeout(pending.current);
    const since = Date.now() - last.current;
    if (force || since > 250) {
      last.current = Date.now();
      onChange(v);
    } else {
      pending.current = setTimeout(() => push(v, true), 250 - since);
    }
  };

  const pct = (x: number) => `${((x + 1) / 2) * 100}%`;
  return (
    <div class={`guess ${pulse ? 'pulse' : ''}`}>
      <div class="guess-track">
        {ghost !== null && <div class="ghost" style={{ left: pct(ghost) }} title="Your locked-in guess" />}
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={local}
          disabled={disabled}
          aria-label="Which answer is the human? Left to right."
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={() => {
            dragging.current = false;
            push(local, true);
          }}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setLocal(v);
            push(v);
          }}
        />
      </div>
      <div class="guess-labels">
        <span>Left is human</span>
        <span>not sure</span>
        <span>Right is human</span>
      </div>
    </div>
  );
}

const pctStr = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

export function Histogram({ bins }: { bins: number[] }) {
  const max = Math.max(1, ...bins);
  return (
    <div class="hist" role="img" aria-label="Distribution of per-question scores from -1 (fooled) to +1 (right)">
      <div class="hist-bars">
        {bins.map((b, i) => (
          <div class={`hist-bar ${i < 5 ? 'neg' : 'pos'}`} style={{ height: `${(b / max) * 100}%` }} title={`${b}`}>
            {b > 0 && <span>{b}</span>}
          </div>
        ))}
      </div>
      <div class="hist-axis">
        <span>−1 fooled</span>
        <span>0</span>
        <span>+1 right</span>
      </div>
    </div>
  );
}

export function StatsCard({ title, s }: { title: string; s: ClassStats }) {
  return (
    <div class="card stats">
      <h3>{title}</h3>
      <div class="stat-grid">
        <Stat label="judged correctly" value={pctStr(s.pctCorrect)} />
        <Stat label="AI judged human" value={pctStr(s.pctLlmJudgedHuman)} />
        <Stat label="avg confidence" value={pctStr(s.avgConfidence)} />
        <Stat label="confidence when right" value={pctStr(s.avgConfidenceRight)} />
        <Stat label="confidence when wrong" value={pctStr(s.avgConfidenceWrong)} />
        <Stat label="questions asked" value={String(s.questions)} />
      </div>
      <Histogram bins={s.histogram} />
      {s.top.length > 0 && (
        <div class="rank">
          <div>
            <b>Top:</b> {s.top.map((t) => `${t.name} (${t.score})`).join(', ')}
          </div>
          {s.bottom.length > 0 && (
            <div>
              <b>Bottom:</b> {s.bottom.map((t) => `${t.name} (${t.score})`).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="stat">
      <div class="stat-v">{value}</div>
      <div class="stat-l">{label}</div>
    </div>
  );
}

export function StatsBundleView({ stats }: { stats: StatsBundle }) {
  return (
    <div class="stats-row">
      {stats.r1 && <StatsCard title="Round 1" s={stats.r1} />}
      {stats.r2 && <StatsCard title="Round 2" s={stats.r2} />}
      {stats.all && <StatsCard title="Whole game" s={stats.all} />}
    </div>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div class="toast" role="alert">{msg}</div> : null;
}

export function ConnBadge({ connected }: { connected: boolean }) {
  return connected ? null : <div class="conn">Reconnecting…</div>;
}
