// ============================================================
// flavorEngine
//
// Turns a structured server chronicle event into a prose flavor
// string by picking a template from FLAVOR_BANK and substituting
// {variables} resolved from the event payload + faction/body
// lookups.
//
// Design rules:
//   - Templates are dumb strings with {var} placeholders. No
//     conditionals — variety comes from multiple variants per kind.
//   - A variant is only usable if EVERY {var} it references resolves
//     to a non-empty value. generateFlavor walks the variants in a
//     deterministic per-event order and returns the first that fully
//     fills. If none fill (missing data), it returns null and the
//     caller falls back to the machine-truth headline.
//   - Deterministic by event id: the same event always renders the
//     same flavor for every viewer, so an MP log reads consistently
//     across clients. Different events of the same kind get variety.
// ============================================================

import { FLAVOR_BANK } from './flavorBank';

// ------------------------------------------------------------
// Inputs the engine needs from the caller (resolved client-side
// where factions + bodies are in scope — i.e. the MP provider).
// ------------------------------------------------------------

export interface FlavorFaction {
  id: string;
  name: string;
  capitalBodyId: string | null;
}

export interface FlavorBody {
  id: string;
  name: string;
  /** Body type label used for {bodyType} (terrestrial / moon / etc.). */
  type: string;
  /** Orbit radius — used to bucket {distance}. Optional; distance
   *  falls back to a generic phrase when missing. */
  orbitRadius?: number;
}

export interface FlavorEvent {
  id: string;
  kind: string;
  tick: number;
  actorFactionId: string | null;
  targetFactionId: string | null;
  payload: Record<string, unknown>;
}

export interface FlavorContext {
  factions: Map<string, FlavorFaction>;
  bodies: Map<string, FlavorBody>;
}

// ------------------------------------------------------------
// Server-event-kind -> flavor-bank-key. Several server kinds use
// different names than the bank (treaty_signed -> pact_signed,
// settlement_built -> settlement_founded). Kinds not in this map
// have no flavor bank yet and fall back to the headline.
// ------------------------------------------------------------

const KIND_MAP: Record<string, string> = {
  ship_destroyed:       'ship_destroyed',
  settlement_destroyed: 'settlement_destroyed',
  settlement_built:     'settlement_founded',
  ship_built:           'ship_built',
  building_completed:   'building_completed',
  secret_discovered:    'secret_discovered',
  trade_accepted:       'trade_accepted',
  treaty_signed:        'pact_signed',
  treaty_broken:        'pact_broken',
  asteroid_impact:      'asteroid_impact',
  senate_vote:          'vote_resolved',
  // No banks wired for these server kinds yet (or the server doesn't
  // emit them under these names): vote_opened, tech_advanced,
  // trade_declined, asteroid_launched.
};

// Secret-kind -> readable {secretName}. Matches the secrets the
// server seeds (see worker/factions.js / src/game/secrets.ts).
const SECRET_NAME: Record<string, string> = {
  portal_to_sun:    'warp gate',
  warp_gate:        'warp gate',
  ancient_city:     'ancient databank',
  free_collector:   'derelict freight hub',
  derelict_warship: 'derelict warship',
  resource_cache:   'buried resource cache',
};

// Deterministic leader-title pool. Picked by hashing the faction
// name so a given faction always has the same title across events
// and clients.
const LEADER_TITLES = [
  'Emperor', 'Premier', 'Director', 'First Speaker', 'President',
  'Prime Minister', 'Chancellor', 'Consul', 'Administrator', 'Sovereign',
];

const PACT_LABEL: Record<string, string> = {
  nap:          'Non-Aggression Pact',
  defense_pact: 'Defense Pact',
  intel_share:  'Intel-Share Pact',
};

// ------------------------------------------------------------
// Deterministic string hash (FNV-1a, 32-bit). Stable across
// clients + reloads so the same event always picks the same
// variant + title.
// ------------------------------------------------------------

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function leaderTitle(factionName: string): string {
  return LEADER_TITLES[hashStr(factionName) % LEADER_TITLES.length];
}

// Bucket a body's orbit radius into a travel-distance phrase. Best
// effort — always returns SOMETHING so {distance} variants aren't
// needlessly skipped (the prose reads fine with any bucket).
function distanceBucket(body: FlavorBody | undefined): string {
  const r = body?.orbitRadius;
  if (r == null || !Number.isFinite(r)) return 'across the system';
  // Thresholds are rough relative bands across the seeded system —
  // inner planets, belt, gas giants, Kuiper. Tuned against the body
  // catalog's orbit radii; exact values don't matter, only the
  // ordering of the bands.
  if (r < 400)  return 'a short hop';
  if (r < 900)  return 'across the inner system';
  if (r < 1800) return 'the long haul to the Belt';
  return 'out past the gas giants';
}

// ------------------------------------------------------------
// Template fill. Replaces {var} with vars[var]. Returns null the
// moment it hits a {var} with no usable value, so the caller can
// try the next variant.
// ------------------------------------------------------------

const VAR_RE = /\{(\w+)\}/g;

function fillTemplate(tpl: string, vars: Record<string, string | undefined>): string | null {
  let missing = false;
  const out = tpl.replace(VAR_RE, (_m, key: string) => {
    const v = vars[key];
    if (v == null || v === '') { missing = true; return ''; }
    return v;
  });
  return missing ? null : out;
}

// ------------------------------------------------------------
// Per-kind variable resolution. Returns the {var} map for an event,
// or null when the kind has no bank / can't be enriched. Names that
// can't resolve are simply left undefined; fillTemplate then skips
// any variant that needs them.
// ------------------------------------------------------------

function fmtBundle(b: unknown): string | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const o = b as Record<string, number>;
  const parts: string[] = [];
  if ((o.metal ?? 0) > 0)   parts.push(`${o.metal} metal`);
  if ((o.fuel ?? 0) > 0)    parts.push(`${o.fuel} fuel`);
  if ((o.gold ?? 0) > 0)    parts.push(`${o.gold} credits`);
  if ((o.science ?? 0) > 0) parts.push(`${o.science} science`);
  return parts.length ? parts.join(', ') : undefined;
}

function resolveVars(ev: FlavorEvent, ctx: FlavorContext): Record<string, string | undefined> | null {
  const bankKey = KIND_MAP[ev.kind];
  if (!bankKey || !FLAVOR_BANK[bankKey]) return null;

  const p = ev.payload;
  const str = (k: string): string | undefined => {
    const v = p[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const num = (k: string): string | undefined => {
    const v = p[k];
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
  };
  const facById = (id: string | null | undefined): FlavorFaction | undefined =>
    id ? ctx.factions.get(id) : undefined;
  const facName = (f: FlavorFaction | undefined, fallbackName?: string): string | undefined =>
    f?.name ?? (fallbackName || undefined);
  const capitalName = (f: FlavorFaction | undefined): string | undefined => {
    const bid = f?.capitalBodyId;
    return bid ? ctx.bodies.get(bid)?.name : undefined;
  };
  const bodyById = (id: string | null | undefined): FlavorBody | undefined =>
    id ? ctx.bodies.get(id) : undefined;
  const bodyByName = (name: string | undefined): FlavorBody | undefined => {
    if (!name) return undefined;
    for (const b of ctx.bodies.values()) if (b.name === name) return b;
    return undefined;
  };

  const tick = `T+${ev.tick}`;

  // Common: actor faction + capital + title.
  const actorFac = facById(ev.actorFactionId);

  switch (ev.kind) {
    case 'ship_destroyed': {
      // Bank {actor} = killer, {partner} = victim (owner).
      const killer = facName(facById(p.killer_faction_id as string | null), p.killer_faction_name as string | undefined);
      const victim = facName(actorFac, p.owner_faction_name as string | undefined);
      return {
        actor: killer,
        partner: victim,
        shipName: str('ship_name'),
        shipClass: (str('ship_class') ?? '').replace(/^\w/, c => c.toUpperCase()) || undefined,
        body: str('body_name'),
        hpLost: num('hp_lost'),
        tick,
      };
    }
    case 'settlement_destroyed': {
      const destroyer = facName(facById(p.killer_faction_id as string | null), p.killer_faction_name as string | undefined);
      const owner = facName(actorFac, p.owner_faction_name as string | undefined);
      return {
        actor: destroyer,
        partner: owner,
        settlementName: str('settlement_name'),
        settlementType: str('settlement_type') ?? 'settlement',
        body: str('body_name'),
        popLost: num('pop_lost'),
        tick,
      };
    }
    case 'settlement_built': {
      const body = bodyByName(str('body_name'));
      return {
        actor: facName(actorFac, p.owner_faction_name as string | undefined),
        settlementName: str('settlement_name'),
        settlementType: str('settlement_type') ?? 'settlement',
        body: str('body_name'),
        bodyType: body?.type,
        distance: distanceBucket(body),
        tick,
      };
    }
    case 'ship_built': {
      return {
        actor: facName(actorFac, p.owner_faction_name as string | undefined),
        shipName: str('ship_name'),
        shipClass: (str('ship_class') ?? '').replace(/^\w/, c => c.toUpperCase()) || undefined,
        body: str('body_name'),
        tick,
      };
    }
    case 'building_completed': {
      const bk = str('building_kind');
      return {
        actor: facName(actorFac, p.owner_faction_name as string | undefined),
        building: bk ? bk.replace(/^\w/, c => c.toUpperCase()) : undefined,
        settlementName: str('settlement_name'),
        body: str('body_name'),
        tick,
      };
    }
    case 'secret_discovered': {
      const body = bodyByName(str('body_name'));
      const secretKind = str('kind');
      return {
        actor: facName(actorFac),
        secretName: secretKind ? (SECRET_NAME[secretKind] ?? secretKind.replace(/_/g, ' ')) : undefined,
        body: str('body_name'),
        bodyType: body?.type,
        tick,
      };
    }
    case 'trade_accepted': {
      const offer = fmtBundle(p.offer);
      const request = fmtBundle(p.request);
      // "1 science for 1 metal" style — needs at least one side.
      let resourceTraded: string | undefined;
      if (offer && request) resourceTraded = `${offer} for ${request}`;
      else if (offer) resourceTraded = offer;
      else if (request) resourceTraded = request;
      return {
        actor: facName(facById(ev.actorFactionId)),
        partner: facName(facById(ev.targetFactionId)),
        resourceTraded,
        tick,
      };
    }
    case 'treaty_signed':
    case 'treaty_broken': {
      const a = facById(ev.actorFactionId);
      const b = facById(ev.targetFactionId);
      const partnerCap = bodyById(b?.capitalBodyId);
      return {
        actor: facName(a),
        partner: facName(b),
        actorCapital: capitalName(a),
        partnerCapital: capitalName(b),
        actorLeaderTitle: a ? leaderTitle(a.name) : undefined,
        partnerLeaderTitle: b ? leaderTitle(b.name) : undefined,
        pactType: PACT_LABEL[str('kind') ?? ''] ?? undefined,
        distance: distanceBucket(partnerCap),
        tick,
      };
    }
    case 'senate_vote': {
      // outcome is the server's status string ('passed' / 'failed' /
      // etc.). title is the bill's display name. proposer = actor.
      const outcome = str('outcome');
      return {
        actor: facName(actorFac),
        voteTitle: str('title'),
        voteOutcome: outcome,
        tick,
      };
    }
    case 'asteroid_impact': {
      const targetBody = bodyByName(str('target_name'));
      return {
        actor: facName(actorFac),
        // partner (target owner) often isn't in the payload — those
        // variants skip and fall to a partner-free one or the headline.
        partner: facName(facById(p.target_owner_faction_id as string | null), p.target_owner_faction_name as string | undefined),
        body: str('target_name'),
        bodyType: targetBody?.type,
        settlementName: str('settlement_name'),
        tick,
      };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------
// Public: generate a flavor string for an event, or null.
// ------------------------------------------------------------

export function generateFlavor(ev: FlavorEvent, ctx: FlavorContext): string | null {
  const bankKey = KIND_MAP[ev.kind];
  if (!bankKey) return null;
  const variants = FLAVOR_BANK[bankKey];
  if (!variants || variants.length === 0) return null;

  const vars = resolveVars(ev, ctx);
  if (!vars) return null;

  // Deterministic rotation: start at a per-event offset so different
  // events of the same kind pick different variants, but the SAME
  // event always starts at the same place. Walk the whole ring and
  // return the first variant that fully fills.
  const start = hashStr(ev.id) % variants.length;
  for (let i = 0; i < variants.length; i++) {
    const tpl = variants[(start + i) % variants.length];
    const filled = fillTemplate(tpl, vars);
    if (filled) return filled;
  }
  return null;
}
