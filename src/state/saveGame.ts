// ============================================================
// Single-player save/load (localStorage)
//
// MP saves are deliberately out of scope — the server is the
// authoritative source there. For SP, we serialize the whole
// GameState plus a small metadata header to localStorage.
//
// Storage layout (under the "orbital.save.v1." prefix):
//   orbital.save.v1.index            -> SaveMeta[]      (lightweight list)
//   orbital.save.v1.blob.<saveId>    -> SaveBlob (JSON) (the full payload)
//
// Why split? Listing saves is cheap (one read of the index).
// We never need to deserialize every blob just to render the picker.
//
// localStorage limits are ~5MB per origin. A typical mid-game
// GameState is a few hundred KB once stringified, so 10–20 saves
// fit comfortably. The writeSave guard rejects entries above ~2MB
// to keep one save from filling the bucket.
// ============================================================

import { GameState } from '../types';
import { createCircularOrbit } from '../physics/orbitalMechanics';

const STORAGE_PREFIX = 'orbital.save.v1';
const INDEX_KEY = `${STORAGE_PREFIX}.index`;
const BLOB_KEY = (saveId: string) => `${STORAGE_PREFIX}.blob.${saveId}`;

/** Bumped when the GameState shape changes incompatibly. Loaders use
 *  this to refuse blobs they can't safely deserialize.
 *
 *  History:
 *    v1 — original schema with Bezier ship.transfer / pendingTransfer
 *    v2 — Bezier→Torch migration. Ships gain optional ship.transit;
 *         load-time migrator force-finishes any v1 in-flight Bezier
 *         transfers (parks ship at destination body, clears the
 *         transfer fields). See migrateV1ToV2 below. */
export const SAVE_SCHEMA_VERSION = 2;

/** Maximum size (bytes) of a single save blob. ~2MB leaves headroom
 *  for several saves on the 5MB localStorage budget. */
const MAX_BLOB_BYTES = 2_000_000;

/** Reserved id for the rolling autosave. Always overwritten in place
 *  so autosaves never balloon the save count. */
export const AUTOSAVE_ID = '__autosave__';

export interface SaveMeta {
  /** Stable slug used in the storage key. Generated at write time. */
  id: string;
  /** Display name picked by the player (defaults to "Campaign T+123"). */
  name: string;
  /** ms-since-epoch when this save was written. */
  savedAt: number;
  /** Game tick at the moment of save. Surfaced in the save picker. */
  currentTick: number;
  /** Quick stats so the picker can render at-a-glance info. */
  playerShipCount: number;
  playerSettlementCount: number;
  /** Schema version this blob was written against (matches SAVE_SCHEMA_VERSION). */
  schemaVersion: number;
  /** Approximate blob size in bytes — surfaced as "187 KB" in the UI. */
  bytes: number;
  /** True if this was written by the autosave loop (rendered differently). */
  isAutosave?: boolean;
}

interface SaveBlob {
  meta: SaveMeta;
  state: GameState;
}

// ---- localStorage helpers (guarded against quota / private mode) ----

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    || 'save';
}

// ---- Public API ----

/**
 * Return the index of all saves, newest first. Cheap — does not
 * deserialize any blobs. Used to render the save picker.
 */
export function listSaves(): SaveMeta[] {
  const idx = readJson<SaveMeta[]>(INDEX_KEY) ?? [];
  // Defensive sort in case the index was hand-edited or imported.
  return idx.slice().sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Write a save. If `existingId` is supplied, overwrites that slot in
 * place (with refreshed timestamp + meta). Returns the new SaveMeta,
 * or null if persistence failed (quota / private mode / too large).
 */
export function writeSave(
  state: GameState,
  name: string,
  existingId?: string,
  isAutosave?: boolean,
): SaveMeta | null {
  const playerShipCount = state.ships.filter(s => s.ownedBy === 'player').length;
  const playerSettlementCount = state.settlements.filter(s => s.ownedBy === 'player').length;

  const id = existingId ?? `${slugify(name)}-${Date.now().toString(36)}`;
  const meta: SaveMeta = {
    id,
    name: name.trim() || `Campaign T+${Math.floor(state.currentTick)}`,
    savedAt: Date.now(),
    currentTick: Math.floor(state.currentTick),
    playerShipCount,
    playerSettlementCount,
    schemaVersion: SAVE_SCHEMA_VERSION,
    bytes: 0, // patched below once we know the serialized size
    isAutosave: isAutosave || id === AUTOSAVE_ID,
  };

  const blob: SaveBlob = { meta, state };
  const serialized = JSON.stringify(blob);
  meta.bytes = serialized.length;
  if (meta.bytes > MAX_BLOB_BYTES) {
    // eslint-disable-next-line no-console
    console.warn('[saveGame] blob too large', meta.bytes, 'bytes; refusing to write');
    return null;
  }

  // Re-stringify with the patched bytes so the stored meta matches the
  // value in the index. Tiny waste; keeps the two in sync.
  const finalSerialized = JSON.stringify({ meta, state });
  try {
    localStorage.setItem(BLOB_KEY(id), finalSerialized);
  } catch {
    // Quota exceeded or unavailable. Surface to caller as null.
    return null;
  }

  // Refresh the index: replace existing entry or prepend new.
  const index = listSaves().filter(m => m.id !== id);
  index.unshift(meta);
  writeJson(INDEX_KEY, index);

  return meta;
}

/**
 * v1 → v2 in-place migration: force-finish any Bezier transfers.
 *
 * v1 saves stored in-flight transfers as ship.transfer / pendingTransfer
 * / queuedTransfers (cubic Bezier control points + Hohmann arrival
 * tick). The v2 engine ignores those fields and drives ships via
 * ship.transit (torch state vector) instead.
 *
 * Rather than try to "re-fly" old transfers under the torch model
 * (the math + timing don't translate cleanly), we apply the Q3 deploy
 * decision: TELEPORT each in-flight ship into a circular parking
 * orbit around its intended destination. Player loses a few ticks of
 * in-flight time in exchange for a clean state-vector world.
 *
 * Mutates the state in place. Safe to call on any version of the
 * GameState — ships without legacy transfer fields are untouched.
 */
function migrateV1ToV2(state: GameState): void {
  for (const ship of state.ships) {
    // Force-finish committed-in-transit (.transfer) — park at arrival.
    if (ship.transfer) {
      const dest = state.bodies.find(b => b.id === ship.transfer!.arrivalBodyId);
      if (dest) {
        const parkRadius = Math.max(dest.radius * 1.5, 6);
        ship.orbit = createCircularOrbit(dest.id, parkRadius, state.currentTick, state.bodies);
      }
      ship.transfer = undefined;
    }
    // Drop the planned/queued bezier intents — the player will replan
    // under the new model from the parked orbit.
    ship.pendingTransfer = undefined;
    ship.queuedTransfers = undefined;
    // Strip any 'transfer' maneuver orders since they reference
    // bezier-shaped arcs in their preOrbit/postOrbit predictions.
    ship.orders = ship.orders.filter(o => o.type !== 'transfer');
  }
}

/**
 * Load a save by id. Returns the deserialized GameState or null if
 * the blob is missing, corrupt, or written against an incompatible
 * schema version. Old-but-migratable schemas are auto-upgraded.
 */
export function readSave(id: string): { state: GameState; meta: SaveMeta } | null {
  const blob = readJson<SaveBlob>(BLOB_KEY(id));
  if (!blob || !blob.state || !blob.meta) return null;
  // v1 → v2: force-finish Bezier transfers, then proceed normally.
  if (blob.meta.schemaVersion === 1 && SAVE_SCHEMA_VERSION >= 2) {
    migrateV1ToV2(blob.state);
    blob.meta.schemaVersion = 2;
  }
  if (blob.meta.schemaVersion !== SAVE_SCHEMA_VERSION) {
    // eslint-disable-next-line no-console
    console.warn(
      '[saveGame] schema mismatch — refusing load',
      'want', SAVE_SCHEMA_VERSION, 'got', blob.meta.schemaVersion,
    );
    return null;
  }
  return { state: blob.state, meta: blob.meta };
}

/**
 * Delete a save and prune it from the index. Idempotent.
 */
export function deleteSave(id: string): void {
  removeKey(BLOB_KEY(id));
  const index = listSaves().filter(m => m.id !== id);
  writeJson(INDEX_KEY, index);
}

/**
 * Download a save as a JSON file so the player can sideload it onto
 * another machine. Uses the standard browser save-as flow — no server.
 */
export function exportSave(id: string): boolean {
  const blob = readJson<SaveBlob>(BLOB_KEY(id));
  if (!blob) return false;
  const json = JSON.stringify(blob, null, 2);
  const file = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  const stamp = new Date(blob.meta.savedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `orbital-save-${blob.meta.id}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Import a save from a JSON file the player selected. Validates the
 * schema version, writes it under a fresh id, and returns the new
 * SaveMeta. Throws (string message) on validation failure so the
 * caller can surface it.
 */
export async function importSave(file: File): Promise<SaveMeta> {
  const text = await file.text();
  let parsed: SaveBlob;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Not valid JSON.'); }

  if (!parsed?.meta || !parsed?.state) throw new Error('File is not an Orbital save.');
  // Same v1 → v2 migration as readSave — exported saves can be
  // brought forward across the Bezier→Torch boundary without losing
  // them; in-flight transfers get force-finished.
  if (parsed.meta.schemaVersion === 1 && SAVE_SCHEMA_VERSION >= 2) {
    migrateV1ToV2(parsed.state);
    parsed.meta.schemaVersion = 2;
  }
  if (parsed.meta.schemaVersion !== SAVE_SCHEMA_VERSION) {
    throw new Error(
      `Save was written against schema v${parsed.meta.schemaVersion}, this build expects v${SAVE_SCHEMA_VERSION}.`,
    );
  }

  const meta = writeSave(parsed.state, `${parsed.meta.name} (imported)`);
  if (!meta) throw new Error('Could not store the imported save (storage may be full).');
  return meta;
}

/** Human-readable byte size for the picker. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Human-readable "5m ago" / "2h ago" / "3d ago" for the picker. */
export function formatSavedAt(ms: number): string {
  const delta = Date.now() - ms;
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
