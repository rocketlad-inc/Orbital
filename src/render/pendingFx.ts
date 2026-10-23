// ============================================================
// pendingFx — effects wait for an audience.
//
// The problem this solves: combat FX used to fire the instant the
// client *noticed* a state change. If you were logged out, looking at
// another planet, or zoomed out to the system view, the explosion
// happened to nobody and was gone forever. Worse, the damage detector
// deliberately skips its first observation (so a page load doesn't
// dump every historical hit at once) — which meant logging in after a
// battle showed you *nothing at all*.
//
// So effects are now QUEUED against the chronicle (the server's
// authoritative event record) and played when the player can actually
// see them:
//
//   - queued from chronicle entries the client hasn't played yet,
//     including ones that happened while logged out;
//   - fired only when the anchor is ON SCREEN and the camera is zoomed
//     in enough to read the scene;
//   - staggered, so a battle replays as a sequence of hits instead of
//     one simultaneous blob;
//   - marked played in localStorage, so each event plays exactly once
//     ever — reloading doesn't re-run the fireworks.
//
// Net effect: zoom into a contested moon and the fight that happened
// while you were away unfolds for you, once, properly.
// ============================================================

/** Chronicle kinds worth a visual, mapped to how they should play. */
export type PendingFxKind =
  | 'destruction' | 'detonation' | 'impact' | 'discovery' | 'damage'
  | 'sterilise' | 'built' | 'gateflash'
  // A Mega Destroyer's second strike: its beam, then the world bursts.
  | 'obliterate'
  // A city or station falling, played where it stood (combatFx).
  | 'settlement_fall'
  // The Leviathan (kaijuFx.ts): its two strikes and its death.
  | 'kaiju_scorch' | 'kaiju_break' | 'kaiju_death'
  // A rammed asteroid burning a living world off (asteroidRam.ts): the
  // sterilisation's fire and ash, no gun beam, landing on its side.
  | 'impact_scorch';

const KIND_MAP: Record<string, PendingFxKind> = {
  ship_destroyed: 'destruction',
  // A city falling played as a 12 px ship-death flash at the WORLD'S
  // CENTRE (siege clip, 2026-10-23: "the city falls only in the
  // outliner"). It plays at the city's marker on the globe now, sized by
  // the globe (combatFx spawnSettlementFall).
  settlement_destroyed: 'settlement_fall',
  builds_destroyed: 'destruction',
  ship_detonated: 'detonation',
  asteroid_impact: 'impact',
  // A missile salvo landing (missiles.js): the same blast at the body.
  missile_strike: 'impact',
  // A salvo shot down in flight (in_flight rows carry where): a burst.
  missile_intercepted: 'damage',
  // A discovery blooms at the body the moment you look at it — the whole
  // reason this queue exists is that these were going unnoticed.
  secret_discovered: 'discovery',
  // Took fire and lived. Queued like the rest so a battle you weren't
  // watching still plays its hits when you look at the body.
  ship_damaged: 'damage',
  // A world killed. The most violent thing in the game had no picture
  // at all — the tick cleared a flag and the planet quietly went back
  // to looking untouched. Queued like the rest, so a strike that landed
  // while you were elsewhere plays when you next look at the planet.
  terraform_destroyed: 'sterilise',
  // A world destroyed outright. The blast, not the slow burn: there is
  // no surface left to burn down to ash, only a debris field. It was the
  // ship-death flash, a pinpoint at the centre, with no beam: Callisto
  // went from whole to rubble between two frames (Studio, 2026-10-23).
  // Now the Mega's beam lands first and the world bursts under it
  // (combatFx spawnObliteration); the world is held whole until then.
  world_obliterated: 'obliterate',
  // A structure razed. It already wrote a chronicle row and drew
  // nothing, so a thing somebody spent the whole game building
  // vanished between two frames.
  megastructure_destroyed: 'destruction',
  // ...and one finishing. The largest construction project in the game
  // landed in total silence while a discovered rock got a firework.
  // Its own kind rather than 'discovery' so it can carry the right
  // flourish — a completion is a celebration, a gate is a spin-up.
  megastructure_complete: 'built',
  gate_transit: 'gateflash',
  kaiju_dead: 'kaiju_death',
};

/** The same chronicle kinds, when the Leviathan did it (payload cause). */
const KAIJU_KIND_MAP: Record<string, PendingFxKind> = {
  terraform_destroyed: 'kaiju_scorch',
  world_obliterated: 'kaiju_break',
};

/** ...and when a rammed asteroid did it (payload cause 'asteroid'). It
 *  played as a Mega Destroyer strike, beam down from the top of the
 *  screen (Studio, 2026-10-23). */
const ASTEROID_KIND_MAP: Record<string, PendingFxKind> = {
  terraform_destroyed: 'impact_scorch',
};

/** The chronicle kind -> the effect it plays, given its payload cause. */
export function fxKindFor(kind: string, cause?: string): PendingFxKind | undefined {
  if (cause === 'kaiju' && KAIJU_KIND_MAP[kind]) return KAIJU_KIND_MAP[kind];
  if (cause === 'asteroid' && ASTEROID_KIND_MAP[kind]) return ASTEROID_KIND_MAP[kind];
  return KIND_MAP[kind];
}

export interface PendingFx {
  /** Chronicle entry id — the dedupe + played-set key. */
  id: string;
  kind: PendingFxKind;
  /** Anchor, already stripped to client-side id space. */
  bodyId?: string;
  shipId?: string;
  /** A settlement's fall: which one (payload settlement_id), so it plays
   *  where that city or station stood. */
  settlementId?: string;
  /** A point in space (world units): a missile burst in flight, where
   *  it met its target. Used when the hull it names is not drawn. */
  at?: { x: number; y: number };
  /** An impact: the unit vector (world axes) from the world toward where
   *  the rock came in, from the row's payload. */
  from?: { x: number; y: number };
  /** When this entered the queue (wall clock). */
  queuedMs: number;
}

/** A world being killed: these fire the moment they can be seen, ahead
 *  of the stagger (drainVisibleFx). */
const WORLD_STRIKES: ReadonlySet<PendingFxKind> = new Set<PendingFxKind>([
  'sterilise', 'obliterate', 'impact_scorch', 'kaiju_scorch', 'kaiju_break',
]);

/** Don't sit on an unwatched effect forever — if the player never looks,
 *  it ages out rather than ambushing them an hour later. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** Gap between two effects firing, so a batch reads as a sequence. */
const STAGGER_MS = 220;
/** Hard cap on the backlog. A long absence shouldn't queue 200 booms;
 *  keep the most recent, drop the rest (they're in the event log). */
const QUEUE_CAP = 24;
/** Remembered played ids per game, capped so localStorage can't grow
 *  without bound over a long match. */
const PLAYED_CAP = 600;

const pending: PendingFx[] = [];
let lastFiredMs = 0;

/** Played-set, lazily loaded from localStorage per game. */
let playedGameId: string | null = null;
let played: Set<string> = new Set();

function playedKey(gameId: string): string {
  return `orbital:fx-played:${gameId}`;
}

function loadPlayed(gameId: string): void {
  if (playedGameId === gameId) return;
  playedGameId = gameId;
  played = new Set();
  try {
    const raw = localStorage.getItem(playedKey(gameId));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) played = new Set(arr.filter(x => typeof x === 'string'));
    }
  } catch { /* private mode / corrupt entry — start clean */ }
}

function persistPlayed(): void {
  if (!playedGameId) return;
  try {
    // Keep the tail (most recently added) when trimming.
    const arr = [...played];
    const trimmed = arr.length > PLAYED_CAP ? arr.slice(arr.length - PLAYED_CAP) : arr;
    if (trimmed.length !== arr.length) played = new Set(trimmed);
    localStorage.setItem(playedKey(playedGameId), JSON.stringify(trimmed));
  } catch { /* storage full / unavailable — in-memory set still works */ }
}

export interface ChronicleFxSource {
  id: string;
  kind: string;
  bodyId?: string;
  shipId?: string;
  /** payload.cause, where the row has one ('kaiju', 'mega_destroyer'). */
  cause?: string;
  /** payload.settlement_id: the settlement a settlement_destroyed names. */
  settlementId?: string;
  /** payload x/y: where an in-flight missile burst. */
  at?: { x: number; y: number };
  /** payload from_dx/from_dy: the side an asteroid came in on. */
  from?: { x: number; y: number };
}

/**
 * Queue any chronicle entries that deserve a visual and haven't played.
 * Safe to call every poll — already-played and already-queued entries
 * are ignored, so re-feeding the same rolling window is a no-op.
 *
 * NOTE on first load: this intentionally DOES queue events from before
 * the session. That's the point — you log in and watch what you missed.
 */
export function ingestChronicleFx(gameId: string, entries: ChronicleFxSource[]): void {
  if (!gameId) return;
  loadPlayed(gameId);
  const nowMs = performance.now();
  for (const e of entries) {
    // The Leviathan's death is its own set piece (kaiju_dead), never a
    // generic boom and wreck on top of it.
    if (e.kind === 'ship_destroyed' && e.shipId && /(^|:)leviathan$/.test(e.shipId)) continue;
    const kind = fxKindFor(e.kind, e.cause);
    if (!kind) continue;
    if (!e.bodyId && !e.shipId && !e.at) continue; // nowhere to draw it
    if (played.has(e.id)) continue;
    if (pending.some(p => p.id === e.id)) continue;
    pending.push({
      id: e.id, kind, bodyId: e.bodyId, shipId: e.shipId, at: e.at, from: e.from, queuedMs: nowMs,
      ...(e.settlementId ? { settlementId: e.settlementId } : {}),
    });
  }
  // Age out the unwatched, then cap to the most recent.
  for (let i = pending.length - 1; i >= 0; i--) {
    if (nowMs - pending[i].queuedMs > PENDING_TTL_MS) pending.splice(i, 1);
  }
  if (pending.length > QUEUE_CAP) pending.splice(0, pending.length - QUEUE_CAP);
}

/**
 * Fire at most one queued effect per STAGGER_MS, and only ones the
 * player can actually see.
 *
 * @param locate  resolve an entry to a canvas position; null when it
 *                isn't visible YET (off-screen, too far zoomed out) —
 *                the entry keeps waiting; or 'skip' when it should never
 *                play at all (e.g. a hit on a ship this client has never
 *                seen — a boom with no visible target reads as a bug).
 *                'skip' consumes the entry silently. Caller owns policy.
 * @param fire    actually spawn the effect at the given position.
 */
export function drainVisibleFx(
  nowMs: number,
  locate: (fx: PendingFx) => { x: number; y: number } | null | 'skip',
  fire: (fx: PendingFx, pos: { x: number; y: number }) => void,
): void {
  if (pending.length === 0) return;

  // A WORLD STRIKE PLAYS THE FRAME IT IS WATCHABLE. The tick that strikes
  // a world also takes its cities and the gun's charge ring off the map,
  // and the world itself is held whole only until its strike begins; so
  // a strike that waited its turn behind the stagger (or behind the
  // cities' own rows) let the kill show before the shot (Venus clip,
  // 2026-10-23). It neither waits for nor holds up the stagger.
  for (let i = 0; i < pending.length; i++) {
    const fx = pending[i];
    if (!WORLD_STRIKES.has(fx.kind)) continue;
    if (nowMs - fx.queuedMs > PENDING_TTL_MS) continue;   // the pass below ages it out
    const pos = locate(fx);
    if (pos === 'skip') {
      pending.splice(i, 1);
      played.add(fx.id);
      persistPlayed();
      i--;
      continue;
    }
    if (!pos) continue;
    pending.splice(i, 1);
    played.add(fx.id);
    persistPlayed();
    fire(fx, pos);
    i--;
  }

  if (nowMs - lastFiredMs < STAGGER_MS) return;

  for (let i = 0; i < pending.length; i++) {
    const fx = pending[i];
    // Expired while waiting — drop silently, no visual.
    if (nowMs - fx.queuedMs > PENDING_TTL_MS) {
      pending.splice(i, 1);
      played.add(fx.id);
      persistPlayed();
      return;
    }
    const pos = locate(fx);
    if (pos === 'skip') {
      // Never playable — consume without a visual and without burning
      // this stagger window on nothing.
      pending.splice(i, 1);
      played.add(fx.id);
      persistPlayed();
      i--;
      continue;
    }
    if (!pos) continue; // not watchable yet — keep waiting
    pending.splice(i, 1);
    played.add(fx.id);
    persistPlayed();
    lastFiredMs = nowMs;
    fire(fx, pos);
    return; // one per stagger window
  }
}

/** Test/debug hook. */
export function resetPendingFx(): void {
  pending.length = 0;
  played = new Set();
  playedGameId = null;
  lastFiredMs = 0;
}

/** How many effects are waiting for the player to look. */
export function pendingFxCount(): number {
  return pending.length;
}
