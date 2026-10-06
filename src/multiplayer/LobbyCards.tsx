// ============================================================
// Lobby game cards — the pieces Browse and My Games are built from.
//
// A card answers, in reading order, what a player picks a game by:
// is it open, running or over (and how far in); how fast its turns
// are; who is in it; who is winning; and the one thing you can do
// about it. Data comes from /api/lobby/browse and /api/lobby/mine
// (worker/lobby.js buildSummaries).
// ============================================================

import React from 'react';
import { FlagChip } from '../components/FactionEmblem';

export type Phase = 'open' | 'full' | 'live' | 'finished';

export interface SummaryPlayer {
  name: string;
  color?: string | null;
  emblem?: string | null;
  worlds?: number;
  out?: boolean;
  is_you?: boolean;
  is_host?: boolean;
  human?: boolean;
}

export interface GameSummary {
  id: string;
  name: string;
  phase: Phase;
  max_players: number;
  member_count: number;
  open_seats: number;
  has_password: boolean;
  quick_join: boolean;
  host_id: string;
  host_name: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  current_tick: number | null;
  next_tick_at: number | null;
  tick_interval_ms: number | null;
  is_member: boolean;
  joinable: boolean;
  players: SummaryPlayer[];
  leader: { name: string; color: string | null; emblem: string | null; worlds: number } | null;
  winner: { name: string; color: string | null; emblem: string | null; victory_type: string | null } | null;
  me: { name: string; color: string | null; emblem: string | null; worlds: number; rank: number | null; out: boolean } | null;
  archived_at_ms?: number | null;
}

// ---------- words ----------

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function until(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.round((ms - now) / 1000);
  if (s <= 30) return 'any moment';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h} h ${m % 60} min`;
}

/** "7.5-minute turns", "1-hour turns". */
/** What a game runs at when its host never picks a speed: one hour a
 *  tick (Lorne, 2026-09-30). Must match DEFAULT_TICK_INTERVAL_MS in
 *  worker/lobby.js, which is what actually starts the game. */
export const DEFAULT_TICK_INTERVAL_MS = 3_600_000;

export function turnSpeed(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}-second turns`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}-minute turns`;
  const h = m / 60;
  return h === 1 ? '1-hour turns' : `${Number.isInteger(h) ? h : h.toFixed(1)}-hour turns`;
}

const worldsWord = (n: number) => `${n} ${n === 1 ? 'world' : 'worlds'}`;

const VICTORY: Record<string, string> = {
  engineering: 'finished the Dyson Sphere',
  domination: 'held most of the worlds',
  chancellor: 'was elected Chancellor',
  annihilation: 'was the last empire standing',
};

export function initials(name: string): string {
  // Letters and digits only: "[agent] lobby-review" is "AL", not "[L".
  const parts = name.replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] ?? '');
  return (a + b).toUpperCase();
}

/** A stable hue per name so lobby avatars are told apart before any
 *  empire colours exist. */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ---------- pieces ----------

export function StatusChip({ g }: { g: GameSummary }) {
  const label = g.phase === 'open'
    ? `Open · ${g.open_seats} ${g.open_seats === 1 ? 'seat' : 'seats'} left`
    : g.phase === 'full'
      ? 'Full · waiting for host'
      : g.phase === 'live'
        ? `Live · Turn ${g.current_tick ?? 0}`
        : 'Finished';
  return (
    <span className={`lx-chip lx-chip--${g.phase}`}>
      <span className="lx-chip__dot" aria-hidden />
      {label}
    </span>
  );
}

export function PlayerStack({ g, max = 10 }: { g: GameSummary; max?: number }) {
  const shown = g.players.slice(0, max);
  const extra = g.players.length - shown.length;
  const empty = g.phase === 'open' || g.phase === 'live' ? Math.min(g.open_seats, Math.max(0, max - shown.length)) : 0;
  return (
    <div className="lx-players">
      <div className="lx-players__row">
        {shown.map((p, i) => (
          <span
            key={i}
            className={`lx-avatar ${p.out ? 'is-out' : ''} ${p.is_you ? 'is-you' : ''}`}
            title={`${p.name}${p.is_host ? ' (host)' : ''}${p.is_you ? ' (you)' : ''}${p.out ? ' (out)' : ''}${p.worlds != null && g.phase !== 'open' && g.phase !== 'full' ? ` · ${worldsWord(p.worlds)}` : ''}`}
          >
            {p.color ? (
              <FlagChip color={p.color} emblem={p.emblem ?? undefined} fallbackKey={p.name} size={30} className="lx-avatar__flag" />
            ) : (
              <span className="lx-avatar__initials" style={{ ['--h' as string]: String(hueOf(p.name)) }}>
                {initials(p.name)}
              </span>
            )}
            {p.is_host && <span className="lx-avatar__crown" aria-label="host">★</span>}
          </span>
        ))}
        {extra > 0 && <span className="lx-avatar lx-avatar--more">+{extra}</span>}
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="lx-avatar lx-avatar--empty" title="Open seat" />
        ))}
      </div>
      <div className="lx-players__caption">
        {g.member_count} of {g.max_players} players
        {g.phase === 'open' || (g.phase === 'live' && g.open_seats > 0)
          ? <> · <b>{g.open_seats} open</b></> : null}
      </div>
    </div>
  );
}

interface CardProps {
  g: GameSummary;
  now: number;
  /** 'browse' offers joining; 'mine' offers opening your own game. */
  variant: 'browse' | 'mine';
  busy?: boolean;
  onPrimary?: () => void;
  /** My Games: the ⋯ menu contents. */
  menu?: React.ReactNode;
  /** This game opens when Orbital launches (Auto-load is on). */
  pinned?: boolean;
  myUserId?: string;
  /** My Games, running games: the Auto-load switch. */
  autoload?: { on: boolean; busy?: boolean; onToggle: () => void };
}

export function GameCard({ g, now, variant, busy, onPrimary, menu, pinned, myUserId, autoload }: CardProps) {
  const speed = turnSpeed(g.tick_interval_ms);
  const iHost = !!myUserId && g.host_id === myUserId;

  const sub = g.phase === 'live'
    ? `Started ${ago(g.started_at, now)}${g.next_tick_at ? ` · next turn ${until(g.next_tick_at, now)}` : ''}`
    : g.phase === 'finished'
      ? `Ended ${ago(g.completed_at, now)} on turn ${g.current_tick ?? 0}`
      : `Hosted by ${iHost ? 'you' : g.host_name} · opened ${ago(g.created_at, now)}`;

  let cta: { label: string; kind: 'primary' | 'secondary' | 'disabled' } ;
  if (variant === 'mine') {
    cta = g.phase === 'live' ? { label: 'Resume', kind: 'primary' }
      : g.phase === 'finished' ? { label: 'View', kind: 'secondary' }
      : iHost && g.phase === 'full' ? { label: 'Start the game', kind: 'primary' }
      : { label: 'Open lobby', kind: 'secondary' };
  } else if (g.is_member) {
    cta = { label: g.phase === 'live' ? 'Resume' : 'Open', kind: 'secondary' };
  } else if (g.joinable) {
    // A private game is only joinable with a password the host shared, so
    // it never wears the gold Join button a stranger can't actually use.
    cta = g.has_password
      ? { label: 'Have the password?', kind: 'secondary' }
      : { label: g.phase === 'live' ? 'Join in progress' : 'Join game', kind: 'primary' };
  } else {
    cta = { label: g.phase === 'full' ? 'Waiting for host' : g.phase === 'finished' ? 'Finished' : 'Full', kind: 'disabled' };
  }

  return (
    <article className={`lx-card lx-card--${g.phase} ${pinned ? 'is-pinned' : ''}`}>
      <div className="lx-card__top">
        <StatusChip g={g} />
        <div className="lx-card__tags">
          {g.has_password && <span className="lx-tag" title="Needs a password to join">Private</span>}
          {g.quick_join && g.phase !== 'finished' && <span className="lx-tag lx-tag--quick" title="Starts itself when the last seat fills">Quick</span>}
          {pinned && <span className="lx-tag lx-tag--pin" title="Opens automatically when you launch Orbital">Auto-loads</span>}
          {menu}
        </div>
      </div>

      <h3 className="lx-card__name" title={g.name}>{g.name}</h3>
      <div className="lx-card__sub">{sub}</div>

      <PlayerStack g={g} />

      <div className="lx-card__facts">
        {speed && <span className="lx-fact"><span className="lx-fact__k">Speed</span>{speed}</span>}
        {g.me && (g.phase === 'live' || g.phase === 'finished') && (
          <span className="lx-fact">
            <span className="lx-fact__k">You</span>
            <FlagChip color={g.me.color ?? '#888'} emblem={g.me.emblem ?? undefined} fallbackKey={g.me.name} size={16} />
            {g.me.out ? `${g.me.name} · out` : `${g.me.name}${g.me.rank ? ` · #${g.me.rank}` : ''} · ${worldsWord(g.me.worlds)}`}
          </span>
        )}
        {/* Who is ahead, unless it is you (your own line already says #1). */}
        {g.phase === 'live' && g.leader && g.me?.rank !== 1 && (
          <span className="lx-fact">
            <span className="lx-fact__k">Leading</span>
            <FlagChip color={g.leader.color ?? '#888'} emblem={g.leader.emblem ?? undefined} fallbackKey={g.leader.name} size={16} />
            {g.leader.name} · {worldsWord(g.leader.worlds)}
          </span>
        )}
        {g.phase === 'finished' && g.winner && (
          <span className="lx-fact">
            <span className="lx-fact__k">Winner</span>
            <FlagChip color={g.winner.color ?? '#888'} emblem={g.winner.emblem ?? undefined} fallbackKey={g.winner.name} size={16} />
            {g.winner.name}{g.winner.victory_type && VICTORY[g.winner.victory_type] ? `, ${VICTORY[g.winner.victory_type]}` : ''}
          </span>
        )}
        {variant === 'mine' && iHost && g.phase === 'full' && (
          <span className="lx-fact lx-fact--nudge">Every seat is taken. Only you can start it.</span>
        )}
      </div>

      {autoload && (
        <label className={`lx-switch ${autoload.on ? 'is-on' : ''}`}>
          <input type="checkbox" checked={autoload.on} disabled={autoload.busy} onChange={autoload.onToggle} />
          <span className="lx-switch__track" aria-hidden><span className="lx-switch__thumb" /></span>
          <span className="lx-switch__text">
            Auto-load on launch
            <span className="lx-switch__hint">{autoload.on ? 'Opens straight into this game' : 'Opens on this page instead'}</span>
          </span>
        </label>
      )}

      <div className="lx-card__foot">
        {cta.kind === 'disabled' ? (
          // Nothing to press: say why, quietly, instead of a dead button.
          <span className="lx-card__none">{cta.label === 'Full' ? 'No open seats' : cta.label}</span>
        ) : (
          <button
            type="button"
            className={`lx-btn lx-btn--${cta.kind}`}
            onClick={onPrimary}
            disabled={busy}
          >
            {busy ? (variant === 'mine' ? 'Opening…' : 'Joining…') : cta.label}
          </button>
        )}
      </div>
    </article>
  );
}
