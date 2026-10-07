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
import { t, tn, relativeTime } from '../i18n/core';
import { useI18n } from '../i18n/react';

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

/** "2 days ago", "yesterday": the browser knows the words in every language. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  return relativeTime(ms - now);
}

export function until(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  if ((ms - now) / 1000 <= 30) return t('card.anyMoment');
  return relativeTime(ms - now);
}

/** "7.5-minute turns", "1-hour turns". */
/** What a game runs at when its host never picks a speed: one hour a
 *  tick (Lorne, 2026-09-30). Must match DEFAULT_TICK_INTERVAL_MS in
 *  worker/lobby.js, which is what actually starts the game. */
export const DEFAULT_TICK_INTERVAL_MS = 3_600_000;

export function turnSpeed(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const s = ms / 1000;
  const tenth = (x: number) => Math.round(x * 10) / 10;
  if (s < 60) return tn('card.turns.sec', Math.round(s));
  const m = s / 60;
  if (m < 60) return tn('card.turns.min', tenth(m));
  return tn('card.turns.hour', tenth(m / 60));
}

const worldsWord = (n: number) => tn('card.worlds', n);

const victoryText = (type: string | null | undefined): string | null => {
  switch (type) {
    case 'engineering': return t('card.victory.engineering');
    case 'domination': return t('card.victory.domination');
    case 'chancellor': return t('card.victory.chancellor');
    case 'annihilation': return t('card.victory.annihilation');
    default: return null;
  }
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
  useI18n();
  const label = g.phase === 'open'
    ? tn('card.status.open', g.open_seats)
    : g.phase === 'full'
      ? t('card.status.full')
      : g.phase === 'live'
        ? t('card.status.live', { n: g.current_tick ?? 0 })
        : t('card.status.finished');
  return (
    <span className={`lx-chip lx-chip--${g.phase}`}>
      <span className="lx-chip__dot" aria-hidden />
      {label}
    </span>
  );
}

export function PlayerStack({ g, max = 10 }: { g: GameSummary; max?: number }) {
  useI18n();
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
            title={`${p.name}${p.is_host ? ` (${t('card.host')})` : ''}${p.is_you ? ` (${t('card.youSuffix')})` : ''}${p.out ? ` (${t('card.out')})` : ''}${p.worlds != null && g.phase !== 'open' && g.phase !== 'full' ? ` · ${worldsWord(p.worlds)}` : ''}`}
          >
            {p.color ? (
              <FlagChip color={p.color} emblem={p.emblem ?? undefined} fallbackKey={p.name} size={30} className="lx-avatar__flag" />
            ) : (
              <span className="lx-avatar__initials" style={{ ['--h' as string]: String(hueOf(p.name)) }}>
                {initials(p.name)}
              </span>
            )}
            {p.is_host && <span className="lx-avatar__crown" aria-label={t('card.host')}>★</span>}
          </span>
        ))}
        {extra > 0 && <span className="lx-avatar lx-avatar--more">+{extra}</span>}
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="lx-avatar lx-avatar--empty" title={t('card.openSeat')} />
        ))}
      </div>
      <div className="lx-players__caption">
        {t('card.players', { n: g.member_count, max: g.max_players })}
        {g.phase === 'open' || (g.phase === 'live' && g.open_seats > 0)
          ? <> · <b>{t('card.openCount', { n: g.open_seats })}</b></> : null}
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
  useI18n();
  const speed = turnSpeed(g.tick_interval_ms);
  const iHost = !!myUserId && g.host_id === myUserId;

  const sub = g.phase === 'live'
    ? `${t('card.started', { when: ago(g.started_at, now) })}${g.next_tick_at ? ` · ${t('card.nextTurn', { when: until(g.next_tick_at, now) })}` : ''}`
    : g.phase === 'finished'
      ? t('card.ended', { when: ago(g.completed_at, now), n: g.current_tick ?? 0 })
      : t('card.hosted', { host: iHost ? t('card.hostedYou') : g.host_name, when: ago(g.created_at, now) });

  let cta: { label: string; kind: 'primary' | 'secondary' | 'disabled' } ;
  if (variant === 'mine') {
    cta = g.phase === 'live' ? { label: t('card.cta.resume'), kind: 'primary' }
      : g.phase === 'finished' ? { label: t('card.cta.view'), kind: 'secondary' }
      : iHost && g.phase === 'full' ? { label: t('card.cta.startGame'), kind: 'primary' }
      : { label: t('card.cta.openLobby'), kind: 'secondary' };
  } else if (g.is_member) {
    cta = { label: g.phase === 'live' ? t('card.cta.resume') : t('card.cta.open'), kind: 'secondary' };
  } else if (g.joinable) {
    // A private game is only joinable with a password the host shared, so
    // it never wears the gold Join button a stranger can't actually use.
    cta = g.has_password
      ? { label: t('card.cta.havePw'), kind: 'secondary' }
      : { label: g.phase === 'live' ? t('card.cta.joinProgress') : t('card.cta.join'), kind: 'primary' };
  } else {
    cta = {
      label: g.phase === 'full' ? t('card.cta.waitingHost') : g.phase === 'finished' ? t('card.status.finished') : t('card.cta.noSeats'),
      kind: 'disabled',
    };
  }

  return (
    <article className={`lx-card lx-card--${g.phase} ${pinned ? 'is-pinned' : ''}`}>
      <div className="lx-card__top">
        <StatusChip g={g} />
        <div className="lx-card__tags">
          {g.has_password && <span className="lx-tag" title={t('card.tag.privateTitle')}>{t('card.tag.private')}</span>}
          {g.quick_join && g.phase !== 'finished' && <span className="lx-tag lx-tag--quick" title={t('card.tag.quickTitle')}>{t('card.tag.quick')}</span>}
          {pinned && <span className="lx-tag lx-tag--pin" title={t('card.tag.pinTitle')}>{t('card.tag.pin')}</span>}
          {menu}
        </div>
      </div>

      <h3 className="lx-card__name" title={g.name}>{g.name}</h3>
      <div className="lx-card__sub">{sub}</div>

      <PlayerStack g={g} />

      <div className="lx-card__facts">
        {speed && <span className="lx-fact"><span className="lx-fact__k">{t('card.fact.speed')}</span>{speed}</span>}
        {g.me && (g.phase === 'live' || g.phase === 'finished') && (
          <span className="lx-fact">
            <span className="lx-fact__k">{t('card.fact.you')}</span>
            <FlagChip color={g.me.color ?? '#888'} emblem={g.me.emblem ?? undefined} fallbackKey={g.me.name} size={16} />
            {g.me.out ? `${g.me.name} · ${t('card.out')}` : `${g.me.name}${g.me.rank ? ` · #${g.me.rank}` : ''} · ${worldsWord(g.me.worlds)}`}
          </span>
        )}
        {/* Who is ahead, unless it is you (your own line already says #1). */}
        {g.phase === 'live' && g.leader && g.me?.rank !== 1 && (
          <span className="lx-fact">
            <span className="lx-fact__k">{t('card.fact.leading')}</span>
            <FlagChip color={g.leader.color ?? '#888'} emblem={g.leader.emblem ?? undefined} fallbackKey={g.leader.name} size={16} />
            {g.leader.name} · {worldsWord(g.leader.worlds)}
          </span>
        )}
        {g.phase === 'finished' && g.winner && (
          <span className="lx-fact">
            <span className="lx-fact__k">{t('card.fact.winner')}</span>
            <FlagChip color={g.winner.color ?? '#888'} emblem={g.winner.emblem ?? undefined} fallbackKey={g.winner.name} size={16} />
            {g.winner.name}{victoryText(g.winner.victory_type) ? `, ${victoryText(g.winner.victory_type)}` : ''}
          </span>
        )}
        {variant === 'mine' && iHost && g.phase === 'full' && (
          <span className="lx-fact lx-fact--nudge">{t('card.nudge')}</span>
        )}
      </div>

      {autoload && (
        <label className={`lx-switch ${autoload.on ? 'is-on' : ''}`}>
          <input type="checkbox" checked={autoload.on} disabled={autoload.busy} onChange={autoload.onToggle} />
          <span className="lx-switch__track" aria-hidden><span className="lx-switch__thumb" /></span>
          <span className="lx-switch__text">
            {t('card.autoload')}
            <span className="lx-switch__hint">{autoload.on ? t('card.autoloadOn') : t('card.autoloadOff')}</span>
          </span>
        </label>
      )}

      <div className="lx-card__foot">
        {cta.kind === 'disabled' ? (
          // Nothing to press: say why, quietly, instead of a dead button.
          <span className="lx-card__none">{cta.label}</span>
        ) : (
          <button
            type="button"
            className={`lx-btn lx-btn--${cta.kind}`}
            onClick={onPrimary}
            disabled={busy}
          >
            {busy ? (variant === 'mine' ? t('card.cta.opening') : t('card.cta.joining')) : cta.label}
          </button>
        )}
      </div>
    </article>
  );
}
