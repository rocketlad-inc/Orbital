// ============================================================
// roomLobbyModel — what the room lobby SAYS, decided in one place.
//
// The lobby screen (RoomLobbyScreen) is only layout: every headline, detail
// line, ready count, "still setting up" list and empire checklist comes from
// the pure functions here, so the wording can be tested for 0..8 players and
// for each viewer (host, player, player who has not finished) without
// rendering anything.
//
// The hierarchy these functions serve (Claude Design "Room lobby"):
//   1. the START card  -> buildStartCard()   one headline, one detail, one action
//   2. YOUR EMPIRE     -> buildEmpire()      calm summary, gold + checklist if unfinished
//   3. PLAYERS         -> buildPlayers()     one row per player
//   4. GAME RULES      -> ruleFacts()        the one-line summary
//
// Strings go through t()/tn() at CALL time (never at module load), so a
// language switch re-words everything on the next render.
// ============================================================

import type { RoomSnapshot } from './api';
import { fmtNumber, t, tk, tn } from '../i18n/core';

/** Real-world time between automatic ticks. Must match the worker's
 *  ALLOWED_TICK_INTERVALS (worker/lobby.js): keep these two lists in sync.
 *
 *  The default is one hour a tick (DEFAULT_TICK_INTERVAL_MS, shared with the
 *  Browse cards in LobbyCards.tsx). The labels are English fallbacks; the
 *  screen reads them through tk('roomlobby.tick.<ms>', label). */
export const TICK_INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  // Sim/agent cadence. Best-effort only: see the ALLOWED_TICK_INTERVALS
  // note in worker/lobby.js; for deterministic full-speed runs drive
  // force-tick in a loop rather than relying on this auto-cadence.
  { label: '1s (sim · best-effort)', value: 1_000 },
  { label: '30s (rapid demo)',     value: 30_000 },
  { label: '60s (demo)',           value: 60_000 },
  { label: '5min (quick play)',    value: 300_000 },
  { label: '7.5min',               value: 450_000 },
  { label: '30min (lunch break)',  value: 1_800_000 },
  { label: '1h (async · DEFAULT)', value: 3_600_000 },
  { label: '2h (12×/day)',         value: 7_200_000 },
  { label: '6h (4×/day)',          value: 21_600_000 },
  { label: '12h (2×/day)',         value: 43_200_000 },
  { label: '24h (1×/day)',         value: 86_400_000 },
];

/** The server's bounds on max_players (worker/lobby.js). The number input
 *  clamps to these; the server re-checks. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

// ---------------------------------------------------------------- players

export interface LobbyPlayer {
  userId: string;
  /** The account's display name. */
  name: string;
  empire: string | null;
  /** Id of the claimed starting world (null = none yet). */
  worldId: string | null;
  /** Its display name, when the room's option list knows it. */
  world: string | null;
  bio: string | null;
  /** Effective readiness. The host is always shown ready: the server's
   *  start never checks the ready map, and the host is the one starting. */
  ready: boolean;
  isHost: boolean;
  isMe: boolean;
  online: boolean;
  commissioned: boolean;
  color: string | null;
  color2: string | null;
  emblem: string | null;
}

/**
 * The room's members as the screen lists them.
 *
 * `mine` carries the viewer's OPTIMISTIC choices (ready flag, starting world):
 * the websocket / PATCH round trip takes 100-300 ms and a click should show
 * at once. They override the snapshot for the viewer only; `undefined` means
 * "follow the server".
 */
export function buildPlayers(
  snap: Pick<RoomSnapshot, 'members' | 'ready' | 'connected' | 'settings'> & Partial<Pick<RoomSnapshot, 'starting_body_options'>>,
  viewerId: string | undefined,
  mine?: { ready?: boolean; worldId?: string | null },
): LobbyPlayer[] {
  const worlds = new Map<string, string>();
  for (const o of snap.starting_body_options ?? []) worlds.set(o.id, o.name);
  return snap.members.map((m) => {
    const isHost = m.userId === snap.settings.host_id;
    const isMe = !!viewerId && m.userId === viewerId;
    const ready = isHost ? true : isMe && mine?.ready != null ? mine.ready : !!snap.ready[m.userId];
    const worldId = isMe && mine?.worldId !== undefined ? mine.worldId : (m.chosen_starting_body ?? null);
    return {
      userId: m.userId,
      name: m.displayName,
      empire: m.empire_name?.trim() ? m.empire_name : null,
      worldId,
      world: worldId ? (worlds.get(worldId) ?? worldId) : null,
      bio: m.bio?.trim() ? m.bio : null,
      ready,
      isHost,
      isMe,
      online: snap.connected.includes(m.userId),
      commissioned: !!m.commissioned,
      color: m.color ?? null,
      color2: m.color2 ?? null,
      emblem: m.emblem ?? null,
    };
  });
}

/** "Ana", "Ana and Bo", "Ana, Bo and Cy", "Ana, Bo and 3 more". Three names
 *  fit a sentence; past that the count says it better than a list. */
export function whoList(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return t('roomlobby.who.two', { a: names[0], b: names[1] });
  if (names.length === 3) return t('roomlobby.who.three', { a: names[0], b: names[1], c: names[2] });
  return t('roomlobby.who.more', { a: names[0], b: names[1], n: names.length - 2 });
}

// -------------------------------------------------------------- rule facts

/** "1-hour ticks", "7.5-minute ticks", "30-second ticks". */
export function tickFact(ms: number): string {
  if (ms >= 3_600_000) return t('roomlobby.fact.tickH', { n: fmtNumber(ms / 3_600_000) });
  if (ms >= 60_000) return t('roomlobby.fact.tickM', { n: fmtNumber(ms / 60_000) });
  return t('roomlobby.fact.tickS', { n: fmtNumber(ms / 1_000) });
}

/** The long label the host's picker uses ("1h (async · DEFAULT)"); an
 *  interval the list does not know prints as its short form. */
export function tickLabel(ms: number): string {
  const known = TICK_INTERVAL_OPTIONS.find((o) => o.value === ms);
  return known ? tk(`roomlobby.tick.${ms}`, known.label) : tickFact(ms);
}

export function mapName(snap: Pick<RoomSnapshot, 'custom_map'>): string {
  return snap.custom_map?.name?.trim() || t('roomlobby.fact.mapSol');
}

export interface RuleFacts {
  speed: string;
  map: string;
  seats: string;
}

export function ruleFacts(snap: Pick<RoomSnapshot, 'settings' | 'custom_map'>): RuleFacts {
  return {
    speed: tickFact(snap.settings.tick_interval_ms),
    map: mapName(snap),
    seats: tn('roomlobby.fact.seats', snap.settings.max_players),
  };
}

/** The Game rules fold's one-line summary: "8 seats · 1-hour ticks · The Sol system". */
export function rulesSummary(f: RuleFacts): string {
  return `${f.seats} · ${f.speed} · ${f.map}`;
}

// -------------------------------------------------------------- start card

export type Viewer = 'host' | 'player' | 'spectator';

export interface StartCardModel {
  viewer: Viewer;
  /** The phase chip: "Lobby · 3 seats open", "Lobby · full", "In progress · tick 4". */
  phase: string;
  headline: string;
  detail: string;
  total: number;
  readyCount: number;
  seatsOpen: number;
  full: boolean;
  /** Host only: may the match start? */
  canStart: boolean;
  /** Why not, when canStart is false (shown, not just a tooltip). */
  startReason: string | null;
  /** Player only: the ready button's state. */
  iAmReady: boolean;
  /** Names of the players (never the host) who are not ready. */
  stillSettingUp: string[];
  hostName: string;
}

export function buildStartCard(input: {
  players: LobbyPlayer[];
  maxPlayers: number;
  started: boolean;
  currentTick?: number | null;
}): StartCardModel {
  const { players, maxPlayers, started } = input;
  const me = players.find((p) => p.isMe);
  const host = players.find((p) => p.isHost);
  const hostName = host?.name ?? t('feed.theHost');
  const total = players.length;
  const readyCount = players.filter((p) => p.ready).length;
  const waiting = players.filter((p) => !p.ready);
  const seatsOpen = Math.max(0, maxPlayers - total);
  const full = seatsOpen === 0;
  const viewer: Viewer = me?.isHost ? 'host' : me ? 'player' : 'spectator';

  const phase = started
    ? t('roomlobby.status.running', { n: input.currentTick ?? 0 })
    : full ? t('roomlobby.phase.full') : tn('roomlobby.phase.open', seatsOpen);

  let headline: string;
  let detail: string;
  if (started) {
    headline = t('roomlobby.model.running.headline');
    detail = t('roomlobby.model.running.detail');
  } else if (viewer === 'host') {
    if (total < MIN_PLAYERS) {
      headline = t('roomlobby.model.alone.headline');
      detail = t('roomlobby.model.alone.detail');
    } else if (waiting.length) {
      headline = t('roomlobby.model.host.in');
      detail = t('roomlobby.model.host.waiting', {
        ready: readyCount, n: total, names: whoList(waiting.map((p) => p.name)),
      });
    } else {
      headline = t('roomlobby.model.host.ready');
      detail = t('roomlobby.model.host.allReady', { n: total });
    }
  } else if (me?.ready) {
    headline = t('roomlobby.model.player.ready');
    detail = t('roomlobby.model.player.detailReady', { ready: readyCount, n: total, host: hostName });
  } else {
    headline = t('roomlobby.model.player.waiting');
    detail = me
      ? t(buildEmpire(me).unfinished ? 'roomlobby.model.player.detailSetup' : 'roomlobby.model.player.detailSet', { host: hostName })
      : t('roomlobby.model.player.detailReady', { ready: readyCount, n: total, host: hostName });
  }

  const canStart = viewer === 'host' && !started && total >= MIN_PLAYERS;
  return {
    viewer, phase, headline, detail, total, readyCount, seatsOpen, full,
    canStart,
    startReason: viewer === 'host' && !started && !canStart ? t('roomlobby.host.needTwo') : null,
    iAmReady: !!me?.ready,
    stillSettingUp: waiting.map((p) => p.name),
    hostName,
  };
}

// ------------------------------------------------------------- your empire

export type CheckState = 'done' | 'todo' | 'optional';

export interface EmpireCheck {
  key: 'name' | 'flag' | 'world' | 'captains';
  label: string;
  state: CheckState;
}

export interface EmpireModel {
  /** Something the player should still do (name, flag or starting world). */
  unfinished: boolean;
  /** The line under the empire name. */
  sub: string;
  /** The empire name, or the nudge to give it one. */
  title: string;
  hasName: boolean;
  /** Name of the claimed starting world (null = none yet). */
  world: string | null;
  checks: EmpireCheck[];
}

export function buildEmpire(me: LobbyPlayer): EmpireModel {
  const hasName = !!me.empire;
  const hasFlag = !!me.color;
  const hasWorld = !!me.worldId;
  const unfinished = !hasName || !hasFlag || !hasWorld;
  const sub = unfinished
    ? (hasName && hasWorld
      ? t('roomlobby.you.subFlag')
      : t('roomlobby.you.subSetup', { name: me.name }))
    : t(me.bio ? 'roomlobby.you.subSetNote' : 'roomlobby.you.subSet', { name: me.name });
  return {
    unfinished,
    sub,
    title: me.empire ?? t('roomlobby.you.nameNeeded'),
    hasName,
    world: me.world,
    checks: [
      { key: 'name', label: t('roomlobby.check.name'), state: hasName ? 'done' : 'todo' },
      { key: 'flag', label: t('roomlobby.check.flag'), state: hasFlag ? 'done' : 'todo' },
      { key: 'world', label: t('roomlobby.check.world'), state: hasWorld ? 'done' : 'todo' },
      { key: 'captains', label: t('roomlobby.check.captains'), state: 'optional' },
    ],
  };
}

// ----------------------------------------------------------------- chat

export interface ChatLine {
  key: number;
  from: { userId: string; displayName: string };
  text: string;
  at: number;
}

/** Which of the three phone tabs is showing. (Desktop has no tabs: the room
 *  panel, the map and the chat dock are all on screen at once.) */
export type RoomTab = 'room' | 'chat' | 'map';

/**
 * Lines from OTHER people that arrived since the chat was last on screen.
 * `seen` is the log length the viewer last saw (the log only grows, capped at
 * 200 from the front, so it is clamped).
 */
export function unreadCount(log: ChatLine[], seen: number, viewerId: string | undefined): number {
  return log.slice(Math.min(Math.max(0, seen), log.length)).filter((l) => l.from.userId !== viewerId).length;
}

/** The newest line as "Ana: see you at Mars", or the invitation to say hello. */
export function chatTeaser(log: ChatLine[], viewerId: string | undefined): string {
  if (log.length === 0) return t('roomlobby.chat.teaserEmpty');
  const last = log[log.length - 1];
  const who = last.from.userId === viewerId ? t('roomlobby.chat.you') : last.from.displayName;
  return `${who}: ${last.text}`;
}

/** The unread dot on a badge: nothing for 0, "9+" past nine. */
export function badgeText(n: number): string {
  return n <= 0 ? '' : n > 9 ? '9+' : String(n);
}
