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
//   - Languages: one bank per language (flavorBank.ts = English,
//     flavorBank.pt-BR.ts = Brazilian Portuguese), entry for entry the
//     same shape. Everything English-grammar-specific (class names,
//     "level N", "for", population words, travel phrases, leader
//     titles, vote outcomes) lives in flavorLocale.ts.
// ============================================================

import { FLAVOR_BANK } from './flavorBank';
import { FLAVOR_BANK_PT } from './flavorBank.pt-BR';
import { TECH_DEFS } from './techs';
import { agreeArticles, lexFor, type FlavorLex, type Gender, type Noun } from './flavorLocale';
import { catalogs, getLang, type Lang } from '../i18n/core';

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
  senate_term:          'chairman_seated',
  senate_law_expired:   'law_expired',
  senate_reaped:        'bill_reaped',
  tech_advanced:        'tech_advanced',
  victory:              'victory',
  // No banks wired for these server kinds yet (or the server doesn't
  // emit them under these names): vote_opened, trade_declined,
  // asteroid_launched.
};

// One bank per language. Entry N of a kind means the same thing in
// every language (same tokens, same order), so the per-event start index
// below picks the matching variant whenever the banks are the same length.
const BANKS: Record<Lang, Record<string, string[]>> = {
  'en': FLAVOR_BANK,
  'pt-BR': FLAVOR_BANK_PT,
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

function leaderTitle(lex: FlavorLex, factionName: string): string {
  return lex.leaderTitles[hashStr(factionName) % lex.leaderTitles.length];
}

// ------------------------------------------------------------
// Template fill. Replaces {var} with vars[var]. Returns null the
// moment it hits a {var} with no usable value, so the caller can
// try the next variant.
// ------------------------------------------------------------

const VAR_RE = /\{(\w+)\}/g;

function fillTemplate(
  tplIn: string,
  vars: Record<string, string | undefined>,
  genders?: Record<string, Gender>,
): string | null {
  // Portuguese: "o {shipClass}" becomes "a {shipClass}" for a feminine noun.
  const tpl = genders ? agreeArticles(tplIn, genders) : tplIn;
  let missing = false;
  const out = tpl.replace(VAR_RE, (_m, key: string) => {
    const v = vars[key];
    if (v == null || v === '') { missing = true; return ''; }
    return v;
  });
  return missing ? null : out;
}

// ------------------------------------------------------------
// Per-kind variable resolution. Returns the {var} map for an event
// (plus the gender of its noun tokens, for Portuguese article
// agreement), or null when the kind has no bank / can't be enriched.
// Names that can't resolve are simply left undefined; fillTemplate
// then skips any variant that needs them.
// ------------------------------------------------------------

interface Resolved {
  vars: Record<string, string | undefined>;
  genders: Record<string, Gender>;
}

function resolveVars(ev: FlavorEvent, ctx: FlavorContext, lang: Lang): Resolved | null {
  const bankKey = KIND_MAP[ev.kind];
  if (!bankKey || !BANKS[lang][bankKey]) return null;

  const lex = lexFor(lang);
  const genders: Record<string, Gender> = {};
  /** Noun token: text goes in the var map, gender (pt-BR) beside it. */
  const noun = (key: string, n: Noun | undefined): string | undefined => {
    if (n?.g) genders[key] = n.g;
    return n?.text;
  };

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
  // Bucket a body's orbit radius into a travel-distance phrase. Best
  // effort — always returns SOMETHING so {distance} variants aren't
  // needlessly skipped (the prose reads fine with any bucket).
  const distanceBucket = (body: FlavorBody | undefined): string => lex.distance(body?.orbitRadius);

  const tick = `T+${ev.tick}`;

  // Common: actor faction + capital + title.
  const actorFac = facById(ev.actorFactionId);

  const vars = ((): Record<string, string | undefined> | null => {
    switch (ev.kind) {
      case 'ship_destroyed': {
        // Bank {actor} = killer, {partner} = victim (owner).
        const killer = facName(facById(p.killer_faction_id as string | null), p.killer_faction_name as string | undefined);
        const victim = facName(actorFac, p.owner_faction_name as string | undefined);
        return {
          actor: killer,
          partner: victim,
          shipName: str('ship_name'),
          shipClass: noun('shipClass', lex.shipClass(str('ship_class'))),
          body: str('body_name'),
          hpLost: num('hp_lost'),
          // Only set on ships that had a captain aboard — older chronicle
          // rows (pre-captains) and captain-less ships leave this
          // undefined, which fillTemplate treats as "skip any variant
          // that needs it."
          captainName: str('captain_name'),
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
          settlementType: noun('settlementType', lex.settlementType(str('settlement_type'))),
          body: str('body_name'),
          // "population 6" reads like a stat, not a loss. Scaled to
          // people (200,000 per pop unit) so the templates below can
          // land the actual weight of a settlement falling.
          popLost: (() => {
            const raw = num('pop_lost');
            return raw ? lex.population(Number(raw)) : undefined;
          })(),
          tick,
        };
      }
      case 'settlement_built': {
        const body = bodyByName(str('body_name'));
        return {
          actor: facName(actorFac, p.owner_faction_name as string | undefined),
          settlementName: str('settlement_name'),
          settlementType: noun('settlementType', lex.settlementType(str('settlement_type'))),
          body: str('body_name'),
          bodyType: noun('bodyType', lex.bodyType(body?.type)),
          distance: distanceBucket(body),
          tick,
        };
      }
      case 'ship_built': {
        return {
          actor: facName(actorFac, p.owner_faction_name as string | undefined),
          shipName: str('ship_name'),
          shipClass: noun('shipClass', lex.shipClass(str('ship_class'))),
          body: str('body_name'),
          tick,
        };
      }
      case 'building_completed': {
        return {
          actor: facName(actorFac, p.owner_faction_name as string | undefined),
          building: noun('building', lex.building(str('building_kind'))),
          settlementName: str('settlement_name'),
          body: str('body_name'),
          tick,
        };
      }
      case 'secret_discovered': {
        const body = bodyByName(str('body_name'));
        return {
          actor: facName(actorFac),
          secretName: noun('secretName', lex.secretName(str('kind'))),
          body: str('body_name'),
          bodyType: noun('bodyType', lex.bodyType(body?.type)),
          tick,
        };
      }
      case 'trade_accepted': {
        const offer = lex.bundle(p.offer);
        const request = lex.bundle(p.request);
        // "1 science for 1 metal" style — needs at least one side.
        return {
          actor: facName(facById(ev.actorFactionId)),
          partner: facName(facById(ev.targetFactionId)),
          resourceTraded: lex.trade(offer, request),
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
          actorLeaderTitle: a ? leaderTitle(lex, a.name) : undefined,
          partnerLeaderTitle: b ? leaderTitle(lex, b.name) : undefined,
          pactType: lex.pactType(str('kind')),
          distance: distanceBucket(partnerCap),
          tick,
        };
      }
      case 'senate_vote': {
        // outcome is the server's status string ('passed' / 'failed' /
        // etc.). title is the bill's display name. proposer = actor.
        return {
          actor: facName(actorFac),
          voteTitle: str('title'),
          voteOutcome: lex.voteOutcome(str('outcome')),
          tick,
        };
      }
      case 'senate_law_expired': {
        // The actor is the faction that PROPOSED the law, not one that
        // acted now — nobody repeals it, the clock simply runs out. The
        // prose has to carry that or it reads as someone striking it down.
        const inForce = p.ticks_in_force;
        return {
          actor: facName(actorFac),
          voteTitle: str('title'),
          ticksInForce: typeof inForce === 'number' ? String(inForce) : undefined,
          tick,
        };
      }
      case 'senate_reaped': {
        // A bill that never even opened for voting. Rare — this is the
        // safety net firing — so the prose stays factual rather than witty.
        return {
          actor: facName(actorFac),
          voteTitle: str('title'),
          tick,
        };
      }
      case 'senate_term': {
        // faction_name is carried in the payload because a term outlives
        // nothing — but the actor lookup can still miss for a faction the
        // caller cannot see, and a chairman announcement with no name is
        // worse than none.
        // num() returns a STRING (every flavor var is a string), so the
        // arithmetic here reads the raw payload instead of round-tripping
        // through it. term_index is 0-based on the wire and 1-based in
        // prose — nobody says "term zero".
        const rawStart = p.start_tick;
        const rawEnd = p.end_tick;
        const rawIdx = p.term_index;
        const span = (typeof rawStart === 'number' && typeof rawEnd === 'number')
          ? rawEnd - rawStart : undefined;
        return {
          actor: facName(actorFac, p.faction_name as string | undefined),
          termNumber: typeof rawIdx === 'number' ? String(rawIdx + 1) : undefined,
          termEnd: num('end_tick'),
          termSpan: span != null ? String(span) : undefined,
          tick,
        };
      }
      case 'asteroid_impact': {
        return {
          actor: facName(actorFac),
          // partner (target owner) often isn't in the payload — those
          // variants skip and fall to a partner-free one or the headline.
          partner: facName(facById(p.target_owner_faction_id as string | null), p.target_owner_faction_name as string | undefined),
          body: str('target_name'),
          bodyType: noun('bodyType', lex.bodyType(bodyByName(str('target_name'))?.type)),
          settlementName: str('settlement_name'),
          tick,
        };
      }
      case 'tech_advanced': {
        // Payload: { tech_id, level, faction_name }. Show WHO advanced WHICH
        // tech to what level. techName from the catalog / TECH_DEFS; fall
        // back to a prettified id if the catalog ever drifts.
        const techId = str('tech_id');
        const def = techId ? (TECH_DEFS as Record<string, { name: string }>)[techId] : undefined;
        // The English name is read from the English catalog (not from
        // TECH_DEFS.name, which follows the UI language) so a requested
        // language never leaks the other one.
        const enName = techId
          ? ((catalogs().en as Record<string, string | undefined>)[`data.tech.${techId}.name`] ?? def?.name)
          : undefined;
        return {
          actor: facName(actorFac, p.faction_name as string | undefined),
          techName: lex.techName(techId, enName),
          techLevel: lex.techLevel(num('level')),
          tick,
        };
      }
      case 'victory': {
        // detail is always populated (src/game/victory.ts, worker/senate.js
        // chancellor path) and already names the specific condition, so
        // the templates below lean on it rather than re-deriving one from
        // victoryType.
        return {
          actor: facName(actorFac),
          detail: lex.victoryDetail(str('detail')),
          tick,
        };
      }
      default:
        return null;
    }
  })();
  return vars ? { vars, genders } : null;
}

// ------------------------------------------------------------
// Public: generate a flavor string for an event, or null.
//
// `lang` defaults to the player's current language, so existing
// callers need no change. Each language walks its OWN bank with the
// same per-event hash; the banks are kept entry-for-entry parallel
// (a test enforces equal length and equal tokens), so an event lands
// on the same variant everywhere. If a bank ever differs in length the
// modulo is taken against that language's own length.
// ------------------------------------------------------------

export function generateFlavor(
  ev: FlavorEvent,
  ctx: FlavorContext,
  lang: Lang = getLang(),
): string | null {
  const bankKey = KIND_MAP[ev.kind];
  if (!bankKey) return null;
  const variants = BANKS[lang]?.[bankKey];
  if (!variants || variants.length === 0) return null;

  const resolved = resolveVars(ev, ctx, lang);
  if (!resolved) return null;
  const genders = lang === 'pt-BR' ? resolved.genders : undefined;

  // Deterministic rotation: start at a per-event offset so different
  // events of the same kind pick different variants, but the SAME
  // event always starts at the same place. Walk the whole ring and
  // return the first variant that fully fills.
  const start = hashStr(ev.id) % variants.length;
  for (let i = 0; i < variants.length; i++) {
    const tpl = variants[(start + i) % variants.length];
    const filled = fillTemplate(tpl, resolved.vars, genders);
    if (filled) return filled;
  }
  return null;
}
