// ============================================================
// Chronicle event -> one-line headline, in a chosen language.
//
// The server writes structured chronicle rows (kind + JSON payload +
// actor/target faction ids). This turns one into the single headline the
// Event Log, the recap and the audit log show, e.g.
//   "T+12  🚀 The game begins — 3 factions: ..."
//
// ONE code path builds every language. The provider calls it twice per row:
//   formatChronicleEvent(ev, ctx, 'en')       -> combatLog (machine truth:
//        the classifiers in EventLog / RecapOverlay, logger.log and the
//        exports all read this English text, so it must not drift)
//   formatChronicleEvent(ev, ctx, getLang())  -> combatLogDisplay
//
// Rules for editing:
//   * The English output is a contract. src/multiplayer/__tests__/
//     eventText.test.ts pins every kind byte for byte.
//   * Every sentence is one catalog key (eventlog.ev.*) with {placeholders},
//     so Portuguese can reorder. Counts use plural pairs (tnIn). The only
//     joins done in code are language-neutral punctuation between whole
//     clauses (" ", " — ", "; ", ", ", " (...)"), each clause being its own
//     translated phrase.
//   * Faction, ship, captain, world and settlement names are data and are
//     interpolated as given. Names that live in the data tables (ship
//     class, tech, building, settlement type) are translated only for a
//     non-English language, so English keeps printing the raw ids it always
//     did.
//   * Text the server composes ITSELF and ships inside the payload
//     (secret_discovered.message, victory.detail, trade_agreement_ended
//     .reason_text) is shown verbatim in English and rebuilt from the
//     payload's structure for other languages; when the structure is not
//     enough the server English is shown (see unrebuilt notes below).
// ============================================================

import {
  tIn, tnIn, tkIn, fmtNumberIn,
  type Key, type Lang, type PluralKey,
} from '../i18n/core';
import { bodyNameIn, designNameIn, settlementNameIn, shipNameIn } from '../i18n/names';

type StripEv<K> = K extends `eventlog.ev.${infer S}` ? S : never;
type EvKey = StripEv<Key>;
type EvPluralKey = StripEv<PluralKey>;
type Vars = Record<string, string | number>;

/** The slice of a server chronicle row the headline needs. */
export interface ChronicleEventRow {
  tick_number: number;
  kind: string;
  payload?: string | null;
  actor_faction_id?: string | null;
  target_faction_id?: string | null;
}

export interface EventTextCtx {
  /** Faction id -> name, for rows written before names rode in the payload. */
  factionNameById: ReadonlyMap<string, string>;
}

type Payload = Record<string, unknown>;

/** World / settlement / ship / design names in a payload, shown in `lang`
 *  (src/i18n/names.ts). The payload carries the stored English names;
 *  English lines keep them verbatim, so the machine-truth copy and the
 *  classifiers that read it never change. */
function namesIn(lang: Lang, p: Payload): Payload {
  if (lang === 'en') return p;
  const out: Payload = { ...p };
  const str = (v: unknown): v is string => typeof v === 'string';
  for (const [k, v] of Object.entries(p)) {
    if (k === 'from_names' && Array.isArray(v)) {
      out[k] = v.map(x => (str(x) ? bodyNameIn(lang, x) : x));
    } else if (!str(v)) {
      continue;
    } else if (k.endsWith('body_name') || k === 'capital_name' || k === 'target_name' || k === 'from_name') {
      out[k] = bodyNameIn(lang, v);
    } else if (k === 'settlement_name') {
      out[k] = settlementNameIn(lang, v);
    } else if (k.endsWith('ship_name')) {
      out[k] = shipNameIn(lang, v);
    } else if (k === 'design_name') {
      out[k] = designNameIn(lang, v);
    }
  }
  return out;
}

/**
 * Rebuild a "DISCOVERY" sentence from the structured payload in `lang`
 * (worker/room.js composes the English one). Returns null when the payload
 * lacks what the sentence needs, so the caller falls back to the server text.
 * Exported for the test that pins the English rebuild to the server's text.
 */
export function secretMessage(lang: Lang, raw: Payload): string | null {
  const p = namesIn(lang, raw);
  const kind = p.kind as string | undefined;
  const body = p.body_name as string | undefined;
  if (!kind || !body) return null;
  const T = (k: EvKey, vars?: Vars) => tIn(lang, `eventlog.ev.${k}` as Key, vars);
  switch (kind) {
    case 'portal_to_sun': return T('secret.portal_to_sun', { body });
    case 'ancient_city': return T('secret.ancient_city', { body });
    case 'pre_terraformed': return T('secret.pre_terraformed', { body });
    case 'derelict_warship': return T('secret.derelict_warship', { body });
    case 'resource_cache': return T('secret.resource_cache', { body });
    case 'ancient_databank': {
      if (typeof p.tech_id !== 'string') return null;
      const tech = lang === 'en' ? p.tech_id : tkIn(lang, `data.tech.${p.tech_id}.name`, p.tech_id);
      return T('secret.ancient_databank', { body, tech });
    }
    case 'ancient_capital':
      if (p.capital_kind === 'mega_destroyer') return T('secret.ancient_capital_mega', { body });
      if (p.capital_kind === 'mobile_foundry') return T('secret.ancient_capital_foundry', { body });
      return null;
    case 'ancient_relay': return T('secret.ancient_relay', { body });
    case 'ancient_station': return T('secret.ancient_station', { body });
    case 'far_gate':
      return typeof p.twin_name === 'string'
        ? T('secret.far_gate', { body, twin: p.twin_name })
        : T('secret.far_gate_close', { body });
    case 'deep_cache':
      if (p.metal == null || p.credits == null) return null;
      return T('secret.deep_cache', { body, metal: String(p.metal), credits: String(p.credits) });
    case 'precursor_orrery': return T('secret.precursor_orrery', { body });
    case 'horizon_archive':
      if (p.science == null) return null;
      return T('secret.horizon_archive', { body, science: String(p.science) });
    default: return null;
  }
}

/** A custom map's hand-placed discovery (worker/room.js, 0167): the map
 *  maker's own name and/or message, verbatim. With only a name, the
 *  kind's own sentence (in this language) follows it; with only a
 *  message, the usual DISCOVERY heading leads it. Null when the find
 *  carries no custom words. */
export function customSecretMessage(lang: Lang, raw: Payload): string | null {
  const p = namesIn(lang, raw);
  const name = typeof p.custom_name === 'string' && p.custom_name ? p.custom_name : null;
  const text = typeof p.custom_text === 'string' && p.custom_text ? p.custom_text : null;
  if (!name && !text) return null;
  const body = typeof p.body_name === 'string' ? p.body_name : '';
  const T = (k: EvKey, vars?: Vars) => tIn(lang, `eventlog.ev.${k}` as Key, vars);
  let tail = text;
  if (!tail) {
    const sentence = secretMessage(lang, p);
    if (!sentence) return null;
    // Every kind's sentence reads "{body}: HEADING — what happened".
    const rest = sentence.startsWith(`${body}: `) ? sentence.slice(body.length + 2) : sentence;
    tail = rest.replace(/^[^—]*—\s*/, '');
  }
  return T('secret.custom', { body, name: name ?? T('secret.discovery'), text: tail });
}

/**
 * A deal of pacts and nothing else. Accepting one writes a trade_accepted
 * row AND a treaty_signed row per pact (worker/trades.js), so the log said
 * the same NAP twice at T+1 (playtest R2-B6). The event log keeps the
 * treaty line and drops this one.
 */
export function isPactOnlyTrade(ev: Pick<ChronicleEventRow, 'kind' | 'payload'>): boolean {
  if (ev.kind !== 'trade_accepted') return false;
  let p: Payload = {};
  try { p = JSON.parse(ev.payload || '{}') ?? {}; } catch { return false; }
  const pacts = Array.isArray(p.pacts) ? p.pacts : [];
  if (pacts.length === 0) return false;
  const sum = (b: unknown) => {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return ['metal', 'fuel', 'gold', 'science'].reduce((s, k) => s + (Number(o[k]) || 0), 0);
  };
  return sum(p.offer) === 0 && sum(p.request) === 0;
}

export function formatChronicleEvent(
  ev: ChronicleEventRow,
  ctx: EventTextCtx,
  lang: Lang,
  /** For SHOWING English (combatLogDisplay), not for the machine-truth
   *  copy: research tracks by their names ("Society") rather than their
   *  ids ("industry"). The log said "completed industry L3" beside a
   *  Herald line about Society (ciurk, 2026-10-16). Other languages
   *  always use names. */
  opts: { names?: boolean } = {},
): string {
  let raw: Payload = {};
  try {
    const j = JSON.parse(ev.payload || '{}');
    if (j !== null && typeof j === 'object') raw = j as Payload;
  } catch { /* ignore */ }
  // Names shown in `lang`; `raw` keeps the stored ones for the rules that
  // need them (a default settlement name below).
  const parsed = namesIn(lang, raw);
  const tp = `T+${ev.tick_number}`;
  const en = lang === 'en';

  const T = (k: EvKey, vars?: Vars): string => tIn(lang, `eventlog.ev.${k}` as Key, vars);
  const N = (k: EvPluralKey, n: number, vars?: Vars): string =>
    tnIn(lang, `eventlog.ev.${k}` as PluralKey, n, { n: num(n), ...vars });
  /** A plain number the way the language writes it. English keeps the raw
   *  String() the headline always used (no thousands separators). */
  const num = (x: unknown): string =>
    en || typeof x !== 'number' || !Number.isFinite(x) ? String(x) : fmtNumberIn(lang, x);
  /** A tick number inside a sentence ("T+45"): always the plain integer, as
   *  the T+n prefix is, never grouped like a quantity. */
  const tickNo = (x: unknown): string => String(x);
  /** The line: "T+n  <glyph><text>". */
  const out = (glyph: string, text: string): string => `${tp}  ${glyph}${text}`;

  const nameOfFaction = (id: string | null | undefined, fallback?: string): string => {
    if (fallback) return fallback;
    if (!id) return T('fb.unknown');
    return ctx.factionNameById.get(id) ?? T('fb.unknown');
  };
  /** "<owner>'s <thing>" / "<thing> de <owner>". */
  const own = (owner: string, thing: string): string => T('possessive', { owner, thing });
  /**
   * Same, minus the stutter when <thing> is already named after its owner.
   * seedGameWorld names every capital "<Faction> Capital", so the naive
   * possessive rendered "Cerean Union's Cerean Union Capital on Oberon ...".
   */
  const possessive = (owner: string, thing: string): string => {
    // "Capital de Cerean Union" names its owner too, just not first.
    if (owner && thing.toLowerCase().includes(owner.toLowerCase())) return thing;
    return own(owner, thing);
  };

  // ---- data-table names: raw ids in English (as always), translated otherwise
  const classText = (raw: string | undefined): string =>
    raw == null ? T('fb.ship') : en ? raw : tkIn(lang, `data.ship.${raw}.name`, raw);
  const settlementText = (raw: string | undefined): string =>
    raw == null ? T('fb.settlement')
      : en ? raw : tkIn(lang, `data.settlement.${raw}.name`, raw).toLowerCase();
  const techText = (raw: string | undefined): string =>
    raw == null ? T('fb.research') : (en && !opts.names) ? raw : tkIn(lang, `data.tech.${raw}.name`, raw);
  const buildingText = (raw: string | undefined): string =>
    raw == null ? T('fb.building') : en ? raw : tkIn(lang, `data.building.${raw}.name`, raw);
  /** "Frigate T3-900" already leads with the class: do not say it twice. */
  const hullOf = (rawCls: string | undefined, name: string): string => {
    const c = classText(rawCls);
    const n = name.toLowerCase();
    return (rawCls != null && n.startsWith(rawCls.toLowerCase())) || n.startsWith(c.toLowerCase())
      ? name : `${c} ${name}`;
  };

  /** "at X" / "in transit, A → B" / "in deep space" for a body + optional destination. */
  const locOf = (where: string): string => parsed.in_transit
    ? (parsed.dest_body_name
      ? T('loc.transit', { from: where, to: String(parsed.dest_body_name) })
      : T('loc.inDeep'))
    : T('loc.at', { where });

  // --------- Session lifecycle ---------
  if (ev.kind === 'game_started') {
    const factions = Array.isArray(parsed.factions)
      ? (parsed.factions as Array<{ name?: string }>)
      : [];
    const names = factions.map(f => f.name).filter(Boolean).join(', ');
    return out('🚀 ', names
      ? N('game.startedNames', factions.length, { names })
      : N('game.started', factions.length));
  }

  // Ended by the idle cull (worker/cull.js): nobody won.
  if (ev.kind === 'game_abandoned') return out('⏹ ', T('game.abandoned'));

  if (ev.kind === 'faction_eliminated') {
    const name = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    return out('☠ ', T('faction.eliminated', { name }));
  }
  if (ev.kind === 'faction_revived') {
    const name = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    return out('', T('faction.revived', { name }));
  }

  if (ev.kind === 'faction_joined') {
    const name = (parsed.name as string) ?? T('fb.newFaction');
    const capital = (parsed.capital_name as string) ?? T('fb.unclaimedWorld');
    return out('', T('faction.joined', { name, capital }));
  }

  if (ev.kind === 'ship_destroyed') {
    const name = (parsed.ship_name as string) ?? T('fb.unknown');
    const clsRaw = parsed.ship_class as string | undefined;
    const where = (parsed.body_name as string) ?? T('fb.space');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    const killer = nameOfFaction(parsed.killer_faction_id as string | null, parsed.killer_faction_name as string | undefined);
    // Only attribute when the chronicle stored a killer id; name the killing
    // HULL in front of its flag when we have it (rows from before
    // killer_ship_name shipped, and settlement/mutual kills, have none).
    const killerShip = parsed.killer_ship_name as string | undefined;
    const by = parsed.killer_faction_id
      ? (killerShip ? T('by.shipFaction', { ship: killerShip, faction: killer }) : T('by.faction', { faction: killer }))
      : null;
    const who = own(owner, hullOf(clsRaw, name));
    // A hull killed in flight was NOT at the body it launched from.
    let loc: string;
    if (parsed.in_transit) {
      const dest = parsed.dest_body_name as string | null;
      loc = dest ? T('loc.transit', { from: where, to: dest }) : T('loc.transitDeep');
    } else {
      loc = T('loc.at', { where });
    }
    return out('', by ? T('ship.destroyedBy', { who, loc, by }) : T('ship.destroyed', { who, loc }));
  }

  if (ev.kind === 'captain_lost' || ev.kind === 'captain_rescued') {
    const cap = (parsed.captain_name as string) ?? T('fb.theCaptain');
    const capRank = Number(parsed.captain_rank ?? 0);
    const kills = capRank > 0 ? N('captain.kills', capRank) : '';
    const ship = parsed.ship_name ? String(parsed.ship_name) : null;
    const where = (parsed.body_name as string) ?? T('fb.deepSpace');
    const loc = locOf(where);
    const lost = ev.kind === 'captain_lost';
    const base = lost
      ? (ship ? T('captain.lostShip', { cap, ship, loc }) : T('captain.lost', { cap, loc }))
      : T('captain.rescued', { cap, loc });
    return out('', kills ? `${base} ${kills}` : base);
  }

  if (ev.kind === 'ship_damaged') {
    // Aggregated server-side per body+owner: a brawl is one line, a lone hit
    // names the hull and its remaining HP.
    const n = Number(parsed.count ?? 1);
    const list = Array.isArray(parsed.ships) ? parsed.ships as Array<Record<string, unknown>> : [];
    const first = list.length > 0 ? list[0] : null;
    const where = (parsed.body_name as string) ?? T('fb.deepSpace');
    const owner = nameOfFaction(ev.actor_faction_id, undefined);
    const loc = locOf(where);
    if (n > 1) {
      return out('', T('damage.many', { owner, n: num(n), loc, dmg: num(parsed.total_damage) }));
    }
    const hpMax = first?.hp_max as number | undefined;
    const nm = (first?.ship_name as string) ?? T('fb.aShipCap');
    const dmg = num((first?.damage as number) ?? parsed.total_damage);
    const who = own(owner, nm);
    return out('', hpMax
      ? T('damage.oneHp', { who, dmg, loc, hp: num(first?.hp_after), max: num(hpMax) })
      : T('damage.one', { who, dmg, loc }));
  }

  if (ev.kind === 'settlement_destroyed') {
    const sName = (parsed.settlement_name as string) ?? null;
    const sType = settlementText(parsed.settlement_type as string | undefined);
    const where = (parsed.body_name as string) ?? T('fb.unknownBody');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    const killer = nameOfFaction(parsed.killer_faction_id as string | null, parsed.killer_faction_name as string | undefined);
    // Type goes in parens rather than in front of the name, so the
    // possessive can still strip an owner-prefixed capital name.
    const label = sName ? `${possessive(owner, sName)} (${sType})` : own(owner, sType);
    // Optional trailing clauses: killer, then "left in ruins" (0142: the
    // ruins are what the reader can act on).
    const tail = (parsed.killer_faction_id ? ` ${T('by.faction', { faction: killer })}` : '')
      + (parsed.wrecked ? ` — ${T('settlement.ruins')}` : '');
    if (parsed.is_capital) return out('⚠ ', `${T('settlement.capitalFell', { owner, where })}${tail}`);
    return out('', `${T('settlement.destroyed', { label, where })}${tail}`);
  }
  if (ev.kind === 'settlement_seized') {
    const who = nameOfFaction(ev.actor_faction_id, undefined);
    const where = (parsed.body_name as string) ?? T('fb.aWorld');
    const what = settlementText(parsed.settlement_type as string | undefined);
    return out('▲ ', parsed.retaken
      ? T('settlement.retook', { who, what, where })
      : T('settlement.seized', { who, what, where }));
  }
  if (ev.kind === 'settlement_razed') {
    const who = nameOfFaction(ev.actor_faction_id, undefined);
    const where = (parsed.body_name as string) ?? T('fb.aWorld');
    return out('✕ ', T('settlement.razed', { who, where }));
  }

  if (ev.kind === 'ship_detonated') {
    const name = (parsed.ship_name as string) ?? T('fb.aShip');
    const where = (parsed.body_name as string) ?? T('fb.orbit');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    const dmg = (parsed.damage as number) ?? 0;
    const killed = (parsed.destroyed_count as number) ?? 0;
    return out('💥 ', T('ship.detonated', { who: own(owner, name), where, dmg: num(dmg), killed: num(killed) }));
  }

  if (ev.kind === 'builds_destroyed') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    const where = (parsed.body_name as string) ?? T('fb.aBody');
    const n = (parsed.builds_lost as number) ?? 0;
    return out('🏭 ', N('ship.buildsLost', n, { owner, where }));
  }

  if (ev.kind === 'ship_retreated') {
    const name = (parsed.ship_name as string) ?? T('fb.aShip');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    const from = (parsed.from_body_name as string) ?? T('fb.theLine');
    const to = (parsed.to_body_name as string) ?? T('fb.friendlyYard');
    const hp = parsed.hp as number | undefined;
    const hpMax = parsed.hp_max as number | undefined;
    // A ship with no shipyard anywhere falls back to a plain station: it
    // survives but nothing repairs it. Older entries predate the flag.
    const repairs = parsed.repairs !== false;
    // Which port and why (migration 0126). Older entries carry no flag.
    const dest = parsed.destination === 'chosen' || parsed.destination === 'home'
      ? parsed.destination : 'near';
    const tail = T(`${repairs ? 'retreat' : 'fall'}.${dest}` as EvKey, { to });
    const who = possessive(owner, name);
    return out('🏳 ', hp != null && hpMax != null
      ? T('ship.retreatedHp', { who, from, hp: num(Math.round(hp)), max: num(hpMax), tail })
      : T('ship.retreated', { who, from, tail }));
  }

  if (ev.kind === 'asteroid_launched') {
    const asteroid = (parsed.asteroid_name as string) ?? T('fb.anAsteroid');
    const target = (parsed.target_name as string) ?? T('fb.aPlanet');
    const eta = (parsed.ticks_to_impact as number) ?? 0;
    const launcher = nameOfFaction(ev.actor_faction_id);
    return out('⚠ ', T('asteroid.launched', { launcher, asteroid, target, eta: num(eta) }));
  }

  if (ev.kind === 'asteroid_impact') {
    const asteroid = (parsed.asteroid_name as string) ?? T('fb.asteroid');
    const target = (parsed.target_name as string) ?? T('fb.aBody');
    const count = (parsed.settlements_destroyed as number) ?? 0;
    const sol = parsed.sol_special === true;
    const aggressor = nameOfFaction(ev.actor_faction_id);
    if (sol) return out('', T('asteroid.sol', { asteroid, aggressor }));
    return out('💥 ', N('asteroid.impact', count, { asteroid, target })
      + (ev.actor_faction_id ? ` (${aggressor})` : ''));
  }

  if (ev.kind === 'settlement_built') {
    const sType = settlementText(parsed.settlement_type as string | undefined);
    // A server default name ("Station", "New City") says nothing the type
    // does not: "fundou Station (estação)" read as a bug (Leo, 2026-10-24).
    // The machine-truth English copy keeps its line as is; the English
    // SHOWN to players drops it too ("founded station Station on
    // Miranda", playtest R2-C6).
    const rawName = (parsed.settlement_name as string) ?? null;
    const sName = rawName && ((en && !opts.names) || !/^(station|new city|city)$/i.test(String(raw.settlement_name ?? '')))
      ? rawName : null;
    const where = (parsed.body_name as string) ?? T('fb.aBody');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    return out('', sName
      ? T('settlement.builtNamed', { owner, type: sType, name: sName, where })
      : T('settlement.built', { owner, type: sType, where }));
  }

  if (ev.kind === 'ship_built') {
    const clsRaw = parsed.ship_class as string | undefined;
    const name = (parsed.ship_name as string) ?? null;
    const where = (parsed.body_name as string) ?? T('fb.orbit');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    // English never de-duplicated here ("a corvette Corvette T3-900"); other
    // languages do, so a default English hull name is not prefixed with a
    // translated class.
    const label = name ? (en ? `${classText(clsRaw)} ${name}` : hullOf(clsRaw, name)) : classText(clsRaw);
    return out('', T('ship.built', { owner, where, label }));
  }

  // --------- Dyson Sphere (megaproject) events ---------
  // EventLog's icon classifier keys on the 'dyson' substring of the ENGLISH
  // text, so the English line always says the word.
  if (ev.kind === 'dyson_initiated') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    return out('☀ ', T('dyson.initiated', { owner }));
  }
  if (ev.kind === 'dyson_milestone') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const pct = (parsed.pct as number) ?? 0;
    return out('☀ ', T('dyson.milestone', { owner, pct: num(pct) }));
  }
  if (ev.kind === 'dyson_damaged') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const dmg = (parsed.damage as number) ?? 0;
    const pct = (parsed.pct as number) ?? 0;
    return out('💥 ', T('dyson.damaged', { owner, dmg: num(dmg), pct: num(pct) }));
  }
  if (ev.kind === 'dyson_collapsed') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const lost = (parsed.progress_lost as number) ?? 0;
    return out('💥 ', T(parsed.reason === 'foundation destroyed' ? 'dyson.collapsedFoundation' : 'dyson.collapsedBombard',
      { owner, lost: num(lost) }));
  }

  // --------- Terraforming ---------
  if (ev.kind === 'terraform_begun') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = (parsed.body_name as string) ?? T('fb.aWorld');
    const dur = (parsed.duration as number) ?? 24;
    return out('◌ ', T('terraform.begun', { owner, where, dur: num(dur) }));
  }
  if (ev.kind === 'terraform_complete') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = (parsed.body_name as string) ?? T('fb.aWorld');
    return out('🌍 ', T('terraform.complete', { where: where.toUpperCase(), owner }));
  }

  // THE THREE BODY EVENT (worker/invasion.js). The science blight that
  // starts it is deliberately NOT here: nothing in the log explains it.
  if (ev.kind === 'invasion_emitter_found') {
    return out('', T('invasion.emitterFound', { where: (parsed.name as string) ?? T('fb.aWorld') }));
  }
  if (ev.kind === 'invasion_emitter_destroyed') return out('', T('invasion.emitterDown'));
  if (ev.kind === 'invasion_launched') {
    return out('', T('invasion.launched', { n: num(Number(parsed.ships) || 0), at: tickNo(Number(parsed.arrive_tick)) }));
  }
  if (ev.kind === 'invasion_gate') {
    const near = parsed.near as string | undefined;
    return out('', near ? T('invasion.gate', { near }) : T('invasion.gateBare'));
  }
  if (ev.kind === 'invasion_assault') {
    const world = (parsed.world as string) ?? T('fb.aWorld');
    const at = tickNo(Number(parsed.arrive_tick));
    return out('', T(parsed.earth ? 'invasion.assaultEarth' : parsed.home ? 'invasion.assaultHome' : 'invasion.assault', { world, at }));
  }
  if (ev.kind === 'invasion_world_taken' || ev.kind === 'invasion_earth_taken') {
    const world = ((parsed.world as string) ?? T('fb.aWorld')).toUpperCase();
    return out('', T(ev.kind === 'invasion_earth_taken' ? 'invasion.takenEarth' : 'invasion.taken', { world }));
  }
  if (ev.kind === 'invasion_done') return out('', T('invasion.done'));
  if (ev.kind === 'invasion_repelled') {
    return out('', T(parsed.why === 'worlds_lost' ? 'invasion.repelledWorlds' : 'invasion.repelledFleet'));
  }

  // THE LEVIATHAN (worker/kaiju.js), every moment of it.
  if (ev.kind === 'kaiju_omen') {
    const system = (parsed.system as string) ?? T('fb.aFarStar');
    return out('✶ ', T('kaiju.omen', { system, ticks: num(Number(parsed.launch_in) || 6) }));
  }
  if (ev.kind === 'kaiju_launched') {
    const system = (parsed.system as string) ?? T('fb.aFarStar');
    const near = parsed.near as string | undefined;
    const at = tickNo(Number(parsed.arrive_tick));
    // Nameless until it attacks (kaiju_revealed).
    return out('✶ ', near
      ? T('kaiju.launchedNear', { system: system.toUpperCase(), near, at })
      : T('kaiju.launched', { system: system.toUpperCase(), at }));
  }
  if (ev.kind === 'kaiju_hunting') {
    const world = (parsed.world as string) ?? T('fb.aWorld');
    const at = tickNo(Number(parsed.arrive_tick));
    const gate = (parsed.gate as string) ?? T('fb.gate');
    return parsed.first
      ? out('✶ ', T(parsed.carried === false ? 'kaiju.arrivedRest' : 'kaiju.arrivedOpen', { gate, world, at }))
      : out('🦑 ', T('kaiju.coming', { world, at }));
  }
  if (ev.kind === 'kaiju_revealed') {
    const world = (parsed.world as string) ?? T('fb.aWorld');
    const hp = Number(parsed.hp) || 0;
    return out('🦑 ', T('kaiju.revealed', {
      system: (parsed.system as string) || T('fb.theFarStar'),
      world,
      at: tickNo(Number(parsed.fires_at_tick)),
      hp: en ? hp.toLocaleString('en-US') : fmtNumberIn(lang, hp),
    }));
  }
  if (ev.kind === 'kaiju_charging') {
    const world = (parsed.world as string) ?? T('fb.aWorld');
    const at = tickNo(Number(parsed.fires_at_tick));
    return out('🦑 ', T(parsed.mode !== 'sterilise' ? 'kaiju.chargeBreak'
      : parsed.raw ? 'kaiju.chargeScorch' : 'kaiju.chargeStrip', { world, at }));
  }
  if ((ev.kind === 'terraform_destroyed' || ev.kind === 'world_obliterated') && parsed.cause === 'kaiju') {
    const where = ((parsed.body_name as string) ?? (parsed.world as string) ?? T('fb.aWorld')).toUpperCase();
    const lost = Number(parsed.settlements_lost) || 0;
    if (ev.kind === 'terraform_destroyed') {
      const base = parsed.raw ? 'kaiju.scorched' : 'kaiju.stripped';
      return out('🦑 ', lost
        ? N(`${base}Lost` as EvPluralKey, lost, { where })
        : T(base as EvKey, { where }));
    }
    return out('🦑 ', lost ? N('kaiju.goneLost', lost, { where }) : T('kaiju.gone', { where }));
  }
  if (ev.kind === 'kaiju_leaving') {
    const eaten = Array.isArray(parsed.eaten) ? (parsed.eaten as string[]) : [];
    const gate = (parsed.gate as string) ?? T('fb.gate');
    const full = parsed.why === 'full';
    if (eaten.length) {
      return out('🦑 ', T(full ? 'kaiju.leavingFullEaten' : 'kaiju.leavingNoneEaten', { eaten: eaten.join(', '), gate }));
    }
    return out('🦑 ', T(full ? 'kaiju.leavingFull' : 'kaiju.leavingNone', { gate }));
  }
  if (ev.kind === 'kaiju_gone') {
    return out('🦑 ', T('kaiju.wentBack', { gate: (parsed.gate as string) ?? T('fb.gate') }));
  }
  if (ev.kind === 'kaiju_dead') {
    const where = (parsed.world as string) ?? T('fb.deepSpace');
    const killer = parsed.killer_faction_name as string | undefined;
    const ship = parsed.killer_ship_name as string | undefined;
    const tons = Number(parsed.tons) || 0;
    const tonsText = en ? tons.toLocaleString('en-US') : fmtNumberIn(lang, tons);
    return out('🦑 ', killer
      ? (ship
        ? T('kaiju.deadKillerShip', { where, killer, ship, tons: tonsText })
        : T('kaiju.deadKiller', { where, killer, tons: tonsText }))
      : T('kaiju.dead', { where, tons: tonsText }));
  }

  if (ev.kind === 'terraform_destroyed' && parsed.cause === 'mega_destroyer') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = ((parsed.body_name as string) ?? (parsed.world as string) ?? T('fb.aLivingWorld')).toUpperCase();
    return out('✹ ', T('mega.biosphereDead', { where, owner }));
  }
  if (ev.kind === 'world_obliterated') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = ((parsed.body_name as string) ?? (parsed.world as string) ?? T('fb.aWorld')).toUpperCase();
    return out('✹ ', T('mega.obliterated', { where, owner }));
  }
  if (ev.kind === 'terraform_destroyed') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = ((parsed.body_name as string) ?? T('fb.aLivingWorld')).toUpperCase();
    const rock = (parsed.asteroid_name as string) ?? T('fb.anAsteroid');
    return out('☄ ', T('mega.asteroidDead', { where, owner, rock }));
  }

  // A WORLD-KILLER WINDING UP: the one public warning in the whole mechanic.
  if (ev.kind === 'mega_strike_charging') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = ((parsed.world as string) ?? T('fb.aLivingWorld')).toUpperCase();
    const hull = (parsed.ship as string) ?? T('fb.aMegaDestroyer');
    const fires = parsed.fires_at_tick as number | undefined;
    const victim = ev.target_faction_id ? nameOfFaction(ev.target_faction_id, undefined) : null;
    const target = victim ? T('mega.targetWorld', { victim }) : T('mega.targetIt');
    return out('✹ ', T('mega.charging', { where, who: own(owner, hull), target })
      + (fires != null ? `; ${T('mega.firesOn', { fires: tickNo(fires) })}` : '')
      + (parsed.mode === 'obliterate' ? `, ${T('mega.shotKills')}` : ''));
  }
  // Stood down, or knocked off the charge by moving.
  if (ev.kind === 'mega_strike_aborted') {
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const where = ((parsed.world as string) ?? T('fb.aWorld')).toUpperCase();
    return out('○ ', T(parsed.reason === 'moved' ? 'mega.abortedMoved' : 'mega.abortedStood', { owner, where }));
  }

  // A STRUCTURE FINISHED. It had no line at all, so the log showed the
  // raw key "megastructure_complete" (playtest R2-C6).
  if (ev.kind === 'megastructure_complete') {
    const who = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const what = ((parsed.structure as string) ?? T('fb.aStructure')).toUpperCase();
    return out('⬢ ', T('mstruct.complete', { who, what }));
  }

  // DERELICTION AND SALVAGE.
  if (ev.kind === 'megastructure_abandoned') {
    const gone = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const what = ((parsed.structure as string) ?? T('fb.aStructure')).toUpperCase();
    return out('⌾ ', T('mstruct.abandoned', { what, gone }));
  }
  if (ev.kind === 'megastructure_claimed') {
    const taker = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const what = ((parsed.structure as string) ?? T('fb.aStructure')).toUpperCase();
    return out('⬢ ', T('mstruct.claimed', { taker, what }));
  }

  // A STRUCTURE CHANGING HANDS: both branches say who lost it as well as
  // who took it.
  if (ev.kind === 'megastructure_captured') {
    const taker = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const from = ev.target_faction_id ? nameOfFaction(ev.target_faction_id, undefined) : T('fb.nobody');
    const what = ((parsed.structure as string) ?? T('fb.aStructure')).toUpperCase();
    const wasDone = parsed.was_complete === true;
    const lostM = Math.round((parsed.lost_metal as number) ?? 0);
    const key = `mstruct.${wasDone ? 'takenOp' : 'takenSite'}${lostM > 0 ? 'Toll' : ''}` as EvKey;
    return out('⬢ ', T(key, { what, taker, from, lost: num(lostM) }));
  }
  if (ev.kind === 'megastructure_destroyed') {
    const razer = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const from = ev.target_faction_id ? nameOfFaction(ev.target_faction_id, undefined) : T('fb.nobody');
    const what = ((parsed.structure as string) ?? T('fb.aStructure')).toUpperCase();
    const m = Math.round((parsed.denied_metal as number) ?? 0);
    return out('✖ ', T(m > 0 ? 'mstruct.razedDenied' : 'mstruct.razed', { what, razer, from, m: num(m) }));
  }

  if (ev.kind === 'ship_rush_botched') {
    // §3 rush gone wrong: the hull still delivers, at half health.
    const clsRaw = parsed.ship_class as string | undefined;
    const name = (parsed.ship_name as string) ?? null;
    const where = (parsed.body_name as string) ?? T('fb.aYard');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const label = name ? (en ? `${classText(clsRaw)} ${name}` : hullOf(clsRaw, name)) : classText(clsRaw);
    const nth = (parsed.rush_count as number) ?? 1;
    return out('⚠ ', T(nth > 1 ? 'rush.botchedN' : 'rush.botched', { owner, label, where, nth: num(nth) }));
  }

  if (ev.kind === 'fleet_arrears') {
    // §1 upkeep transitions: entering or clearing arrears.
    const owner = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    return parsed.entered === true
      ? out('💸 ', T('arrears.entered', { owner }))
      : out('💰 ', T('arrears.cleared', { owner }));
  }

  if (ev.kind === 'building_completed') {
    const kind = buildingText(parsed.building_kind as string | undefined);
    const lvl = (parsed.new_level as number) ?? 1;
    const sName = (parsed.settlement_name as string) ?? T('fb.settlement');
    const where = (parsed.body_name as string) ?? T('fb.aBody');
    const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
    return out('', T('building.completed', { who: possessive(owner, sName), where, kind, lvl: num(lvl) }));
  }

  // THE SUN GATES (worker/sunGates.js): the warning before each gate, a gate
  // leaving the Sun, a gate opening, a hull going through.
  if (ev.kind === 'sun_gate_omen') {
    const wait = Number(parsed.gate_in) || 6;
    const again = Number(parsed.index) > 0;
    return out('☀ ', T(again ? 'sungate.omenElse' : 'sungate.omenStrange', { wait: num(wait) }));
  }
  if (ev.kind === 'sun_gate_emerged') {
    const system = (parsed.system as string) ?? T('fb.anotherStar');
    const near = parsed.near as string | undefined;
    const atN = Number(parsed.arrive_tick);
    const at = Number.isFinite(atN);
    const key = `sungate.emerged${near ? 'Near' : ''}${at ? 'At' : ''}` as EvKey;
    return out('◎ ', T(key, { system, near: near ?? '', at: tickNo(atN) }));
  }
  if (ev.kind === 'gate_transit') {
    // Any gate, ancient or sun.
    const owner = nameOfFaction(ev.actor_faction_id);
    const ship = (parsed.ship as string) ?? T('fb.aHull');
    const from = (parsed.from as string) ?? T('fb.aGate');
    const to = (parsed.sun_gate ? (parsed.to_system as string | undefined) : undefined)
      ?? (parsed.to as string) ?? T('fb.farSide');
    return parsed.first
      ? out('◎ ', T('gate.transitFirst', { owner, from, ship, to }))
      : out('◎ ', T('gate.transit', { who: possessive(owner, ship), from, to }));
  }
  if (ev.kind === 'sun_gate_opened') {
    const gate = (parsed.gate as string) ?? T('fb.theGateCap');
    const system = (parsed.system as string) ?? T('fb.anotherStar');
    return out('◎ ', T('sungate.opened', { gate, system }));
  }

  if (ev.kind === 'missile_launch') {
    if (parsed.at_missiles) {
      return out('🚀 ', T('missile.launchShootDown', {
        n: Number(parsed.count ?? 0), who: String(parsed.target_owner_name ?? T('fb.aBody')),
        body: String(parsed.from_name ?? T('fb.aBody')), tick: Number(parsed.meet_tick ?? 0),
      }));
    }
    if (parsed.in_flight) {
      return out('🚀 ', T(parsed.auto ? 'missile.launchInterceptAuto' : 'missile.launchIntercept', {
        n: Number(parsed.count ?? 0), who: String(parsed.target_owner_name ?? T('fb.aBody')),
        k: Number(parsed.target_hulls ?? 0), body: String(parsed.body_name ?? T('fb.aBody')), tick: Number(parsed.meet_tick ?? 0),
      }));
    }
    return out('🚀 ', T('missile.launch', {
      n: Number(parsed.count ?? 0), body: String(parsed.body_name ?? T('fb.aBody')), tick: Number(parsed.arrive_tick ?? 0),
    }));
  }
  if (ev.kind === 'missile_strike') {
    const who = (Array.isArray(parsed.launcher_names) && parsed.launcher_names.length)
      ? (parsed.launcher_names as string[]).join(', ') : nameOfFaction(ev.actor_faction_id);
    const vars = {
      who, n: Number(parsed.missiles ?? 0), body: String(parsed.body_name ?? T('fb.aBody')),
      dmg: Number(parsed.damage ?? 0), k: Number(parsed.destroyed_count ?? 0),
    };
    if (parsed.in_flight) {
      return out('🚀 ', T('missile.strikeInFlight', { ...vars, owner: String(parsed.target_owner_name ?? '?') }));
    }
    return out('🚀 ', parsed.auto ? T('missile.strikeAuto', vars) : T('missile.strike', vars));
  }
  if (ev.kind === 'missile_inbound') {
    return out('🎯 ', T('missile.inbound', {
      who: String(parsed.launcher_name ?? nameOfFaction(ev.actor_faction_id)), n: Number(parsed.count ?? 0),
      k: Number(parsed.target_hulls ?? 1), body: String(parsed.body_name ?? T('fb.aBody')), tick: Number(parsed.meet_tick ?? 0),
    }));
  }
  if (ev.kind === 'missile_intercepted' && parsed.in_flight) {
    return out('🛡 ', T('missile.interceptedInFlight', {
      who: String(parsed.by_name ?? nameOfFaction(ev.actor_faction_id)), n: Number(parsed.count ?? 0),
      from: (Array.isArray(parsed.from_names) && parsed.from_names.length) ? (parsed.from_names as string[]).join(', ') : '?',
      body: String(parsed.body_name ?? T('fb.aBody')), left: Number(parsed.got_through ?? 0),
    }));
  }
  if (ev.kind === 'missile_intercepted') {
    return out('🛡 ', T('missile.intercepted', {
      who: String(parsed.by_name ?? nameOfFaction(ev.actor_faction_id)),
      n: Number(parsed.count ?? 0), body: String(parsed.body_name ?? T('fb.aBody')),
    }));
  }

  if (ev.kind === 'discovery_offer' || ev.kind === 'discovery_refused') {
    const shipKey = parsed.kind === 'ancient_capital'
      ? (parsed.capital_kind === 'mobile_foundry' ? 'mobile_foundry' : 'mega_destroyer')
      : 'destroyer';
    const ship = tIn(lang, `discovery.offer.ship.${shipKey}` as Key);
    const body = String(parsed.body_name ?? T('fb.aBody'));
    return ev.kind === 'discovery_offer'
      ? out('✦ ', T('secret.offer', { ship, body, tick: Number(parsed.expires_tick ?? 0) }))
      : out('✦ ', T('secret.refused', { ship, body }));
  }

  if (ev.kind === 'secret_discovered') {
    // The server writes the English sentence into the payload. English
    // shows it as is; other languages rebuild it from the payload's
    // structure (kind + names + amounts), falling back to the server text.
    const owner = nameOfFaction(ev.actor_faction_id);
    const server = (parsed.message as string) ?? null;
    const custom = customSecretMessage(lang, parsed);
    const rebuilt = custom ?? (en ? null : secretMessage(lang, parsed));
    const msg = rebuilt ?? server ?? T('secret.fallback', {
      kind: String(parsed.kind ?? T('fb.something')),
      body: String(parsed.body_name ?? T('fb.aBody')),
    });
    return out('🔍 ', T('secret.line', { owner, msg }));
  }

  if (ev.kind === 'victory') {
    // `detail` is composed by the server (src/game/victory.ts, room.js
    // checkVictory, senate.js). English shows it; other languages rebuild
    // it from victoryType (+ the winner, or the counts in the domination
    // line) and otherwise show the server text.
    const winner = nameOfFaction(ev.actor_faction_id);
    const serverDetail = (parsed.detail as string) ?? null;
    let detail = serverDetail;
    if (!en) {
      const vt = parsed.victoryType;
      const m = serverDetail ? /^Controls (\d+) of (\d+) worlds \((\d+)%\)$/.exec(serverDetail) : null;
      if (vt === 'annihilation') return out('👑 ', T('victory.annihilation'));
      if (vt === 'engineering') detail = T('victory.detail.engineering');
      else if (vt === 'chancellor') detail = T('victory.detail.chancellor', { winner });
      else if (vt === 'domination' && m) {
        detail = T('victory.detail.domination', { n: num(Number(m[1])), total: num(Number(m[2])), pct: num(Number(m[3])) });
      }
    }
    return out('👑 ', detail ? T('victory.lineDetail', { winner, detail }) : T('victory.line', { winner }));
  }

  // --------- Diplomacy events ---------
  const pactLabel = (k: string): string => {
    if (k === 'nap') return T('pact.nap');
    if (k === 'defense_pact') return T('pact.defense');
    if (k === 'intel_share') return T('pact.intel');
    return T('fb.pact');
  };

  // Human-readable resource bundle. Drops zero entries so a pure-pact trade
  // doesn't say "0M 0F 0C 0S".
  const fmtBundle = (b: unknown): string => {
    if (!b || typeof b !== 'object') return T('fb.nothing');
    const o = b as Record<string, number>;
    const parts: string[] = [];
    // Round for display: trade bundles can carry fp residue.
    if ((o.metal ?? 0) > 0)   parts.push(T('bundle.metal', { n: num(Math.round(o.metal)) }));
    if ((o.fuel ?? 0) > 0)    parts.push(T('bundle.fuel', { n: num(Math.round(o.fuel)) }));
    if ((o.gold ?? 0) > 0)    parts.push(T('bundle.credits', { n: num(Math.round(o.gold)) }));
    if ((o.science ?? 0) > 0) parts.push(T('bundle.science', { n: num(Math.round(o.science)) }));
    return parts.length ? parts.join(', ') : T('fb.nothing');
  };
  /** "12M 3C" cargo codes (metal / fuel / credits / science). Language-neutral. */
  const cargoCodes = (get: (k: 'metal' | 'fuel' | 'gold' | 'science') => number): string[] => {
    const bits: string[] = [];
    for (const [k, label] of [['metal', 'M'], ['fuel', 'F'], ['gold', 'C'], ['science', 'S']] as const) {
      const v = get(k);
      if (v > 0) bits.push(`${num(Math.round(v))}${label}`);
    }
    return bits;
  };

  if (ev.kind === 'trade_accepted') {
    // (A pact-only deal is filtered out of the log upstream:
    // isPactOnlyTrade. This still words it for any other caller.)
    const proposer = nameOfFaction(ev.actor_faction_id);
    const responder = nameOfFaction(ev.target_faction_id);
    const offer = fmtBundle(parsed.offer);
    const request = fmtBundle(parsed.request);
    const pacts = Array.isArray(parsed.pacts) ? (parsed.pacts as string[]) : [];
    const nothing = T('fb.nothing');
    const pactList = pacts.map(pactLabel).join(', ');
    // A pure pact deal is not a trade of nothing for nothing (playtest
    // 2026-10-24): say who accepted which pacts.
    if (pacts.length && offer === nothing && request === nothing) {
      return out('⚖ ', T('trade.pactsOnly', { proposer, responder, pacts: pactList }));
    }
    if (pacts.length && request === nothing) {
      return out('⚖ ', T('trade.acceptedPactsFor', { proposer, offer, responder, pacts: pactList }));
    }
    return out('⚖ ', pacts.length
      ? T('trade.acceptedPacts', { proposer, offer, responder, request, pacts: pactList })
      : T('trade.accepted', { proposer, offer, responder, request }));
  }

  if (ev.kind === 'meteoroid_found') {
    const tons = Number(parsed.tons ?? 0);
    const unit = T(parsed.kind === 'gold' ? 'unit.credits' : 'unit.metal');
    // The find banks nothing; the ore waits in the rock for a freighter.
    // The old "Survey found Rock 9 — 400 credits" read like a payout.
    return out('◈ ', tons > 0 && parsed.name
      ? T('meteoroid.foundTons', { name: String(parsed.name), tons: num(tons), unit })
      : T('meteoroid.found', { name: String(parsed.name ?? T('fb.aMeteoroid')) }));
  }

  if (ev.kind === 'meteoroid_exhausted') {
    return out('◇ ', T('meteoroid.exhausted', { name: String(parsed.name ?? T('fb.aMeteoroidCap')) }));
  }

  if (ev.kind === 'ship_refitted') {
    const fee = [
      Number(parsed.fee_metal ?? 0) > 0 ? `${num(Math.round(Number(parsed.fee_metal)))}M` : null,
      Number(parsed.fee_gold ?? 0) > 0 ? `${num(Math.round(Number(parsed.fee_gold)))}C` : null,
    ].filter(Boolean).join(' ');
    const vars = {
      ship: String(parsed.ship_name ?? T('fb.aShipCap')),
      design: String(parsed.design_name ?? T('fb.newDesign')),
      where: String(parsed.body_name ?? T('fb.friendlyWorld')),
      fee,
    };
    return out('⟳ ', T(fee ? 'refit.doneFee' : 'refit.done', vars));
  }

  if (ev.kind === 'treaty_signed') {
    const a = nameOfFaction(ev.actor_faction_id);
    const b = nameOfFaction(ev.target_faction_id);
    return out('🕊 ', T('treaty.signed', { a, b, kind: pactLabel((parsed.kind as string) ?? 'pact') }));
  }

  if (ev.kind === 'treaty_broken') {
    const breaker = nameOfFaction(ev.actor_faction_id);
    const other = nameOfFaction(ev.target_faction_id);
    return out('⚔ ', T('treaty.broken', { breaker, other, kind: pactLabel((parsed.kind as string) ?? 'pact') }));
  }

  // ---- war and peace (worker/wars.js) ----
  if (ev.kind === 'war_declared') {
    const a = nameOfFaction(ev.actor_faction_id);
    const b = nameOfFaction(ev.target_faction_id);
    const broke = Array.isArray(parsed.broke_pacts) ? (parsed.broke_pacts as string[]) : [];
    return out('⚔ ', broke.length
      ? T('war.declaredBroke', { a, b, pacts: broke.map(pactLabel).join(', ') })
      : T('war.declared', { a, b }));
  }
  if (ev.kind === 'war_ended') {
    const a = nameOfFaction(ev.actor_faction_id);
    const b = nameOfFaction(ev.target_faction_id);
    return out('🕊 ', N('war.ended', Number(parsed.ticks_fought ?? 0), { a, b }));
  }
  if (ev.kind === 'ceasefire_offered' || ev.kind === 'ceasefire_withdrawn') {
    const a = nameOfFaction(ev.actor_faction_id);
    const b = nameOfFaction(ev.target_faction_id);
    return out('', T(ev.kind === 'ceasefire_offered' ? 'war.ceasefire' : 'war.ceasefireWithdrawn', { a, b }));
  }

  /** " [slider law]": the bill kind in brackets, as a clause. */
  const billKind = (): string => {
    if (!parsed.bill_kind) return '';
    const raw = String(parsed.bill_kind);
    return ` [${en ? raw.replace(/_/g, ' ') : tkIn(lang, `senate.kind.${raw}`, raw.replace(/_/g, ' '))}]`;
  };

  if (ev.kind === 'senate_vote') {
    // Full result, not just "resolved": bill kind + tally is the whole point
    // of a senate line.
    const title = (parsed.title as string) ?? T('fb.aMotion');
    const outcome = (parsed.outcome as string) ?? T('fb.resolved');
    // Ballots cast, one per senator, where the row has them: the weights
    // read as "2 yea / 0 nay / 2 abstain" in a three-empire game
    // (playtest R2-B2). Older rows carry only the weights.
    const counted = parsed.yea_count != null;
    const yea = Number((counted ? parsed.yea_count : parsed.yea_weight) ?? 0);
    const nay = Number((counted ? parsed.nay_count : parsed.nay_weight) ?? 0);
    const abs = Number((counted ? parsed.abstain_count : parsed.abstain_weight) ?? 0);
    const tally = (yea || nay || abs)
      ? ` — ${abs
        ? T('senate.tallyAbs', { yea: num(yea), nay: num(nay), abs: num(abs) })
        : T('senate.tally', { yea: num(yea), nay: num(nay) })}`
      : '';
    const verb = outcome === 'passed' ? T('senate.passed')
      : outcome === 'failed' ? T('senate.failed') : outcome.toUpperCase();
    return out('⚖ ', T('senate.vote', { title, kind: billKind(), verb, tally }));
  }

  if (ev.kind === 'senate_law_expired') {
    // Leads with LAPSED so it can't be misread as a repeal: no one voted
    // this down, the clause simply ran out.
    const title = (parsed.title as string) ?? T('fb.aLaw');
    const held = Number(parsed.ticks_in_force ?? 0);
    const heldBit = held > 0 ? ` — ${N('senate.stood', held)}` : '';
    return out('⌛ ', T('senate.lapsed', { title, kind: billKind(), held: heldBit }));
  }

  if (ev.kind === 'senate_reaped') {
    const title = (parsed.title as string) ?? T('fb.aMotion');
    const who = nameOfFaction(ev.actor_faction_id);
    return out('⚖ ', T('senate.reaped', { title, who }));
  }

  if (ev.kind === 'senate_term') {
    // A term handover is a schedule announcement, so it leads with the
    // DEADLINE.
    const who = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const n = Number(parsed.term_index ?? 0) + 1;
    const until = Number(parsed.end_tick ?? 0);
    const span = until - Number(parsed.start_tick ?? 0);
    return out('🔨 ', T('senate.term', { who, term: num(n), span: num(span), until: tickNo(until) }));
  }

  if (ev.kind === 'tech_advanced') {
    const who = nameOfFaction(ev.actor_faction_id, parsed.faction_name as string | undefined);
    const tech = techText(parsed.tech_id as string | undefined);
    return out('', parsed.level != null
      ? T('tech.advancedLvl', { who, tech, lvl: num(parsed.level) })
      : T('tech.advanced', { who, tech }));
  }

  if (ev.kind === 'trade_route_run') {
    // One line per completed loop: a standing route is automation, so it
    // leaves a paper trail.
    const d = (parsed.delivered ?? {}) as Record<string, number>;
    const bits = cargoCodes(k => Number(d[k] ?? 0));
    const from = nameOfFaction(parsed.sender_faction_id as string | null, undefined);
    const to = nameOfFaction(parsed.recipient_faction_id as string | null, undefined);
    const loop = Number(parsed.loop ?? 0);
    const tariff = Number(parsed.tariff_pct ?? 0);
    const cargo = bits.length ? bits.join(' ') : T('fb.nothing');
    return out('⟳ ', T(tariff > 0 ? 'route.runTariff' : 'route.run',
      { from, to, cargo, tariff: num(tariff), loop: num(loop) }));
  }

  // Both of these are party-scoped.
  if (ev.kind === 'trade_route_done') {
    const from = nameOfFaction(parsed.sender_faction_id as string | null, undefined);
    const to = nameOfFaction(parsed.recipient_faction_id as string | null, undefined);
    const loops = Number(parsed.loops ?? parsed.loop ?? 0);
    return out('⏹ ', T(loops > 0 ? 'route.doneLoops' : 'route.done', { from, to, loops: num(loops) }));
  }

  if (ev.kind === 'trade_lane_consolidated') {
    const n = Array.isArray(parsed.ships) ? (parsed.ships as string[]).length : 0;
    return out('⇄ ', n > 0 ? N('route.folded', n) : T('route.foldedNone'));
  }

  if (ev.kind === 'trade_agreement_ended') {
    const a = nameOfFaction(parsed.faction_a_id as string | null, parsed.faction_a_name as string | undefined);
    const b = nameOfFaction(parsed.faction_b_id as string | null, parsed.faction_b_name as string | undefined);
    // reason_text is the server's English clause; other languages key off
    // `reason` and fall back to that text for a reason they do not know.
    const serverWhy = (parsed.reason_text as string) ?? T('fb.ended');
    const why = en ? serverWhy
      : typeof parsed.reason === 'string' ? tkIn(lang, `eventlog.ev.why.${parsed.reason}`, serverWhy) : serverWhy;
    return out('⏹ ', T('route.agreementEnded', { a, b, why }));
  }

  if (ev.kind === 'trade_delivered') {
    const bits = cargoCodes(k => Number(parsed[k] ?? 0));
    const cargo = bits.length > 0 ? bits.join(' ') : T('fb.emptyHold');
    const to = nameOfFaction(parsed.recipient_faction_id as string | null, undefined);
    return out('', T('trade.delivered', { to, cargo }));
  }

  if (ev.kind === 'trade_shipment_lost') {
    const bits = cargoCodes(k => Number(parsed[k] ?? 0));
    const cargo = bits.length > 0 ? bits.join(' ') : T('fb.itsCargo');
    const sender = nameOfFaction(parsed.sender_faction_id as string | null, undefined);
    const recipient = nameOfFaction(parsed.recipient_faction_id as string | null, undefined);
    return out('📦 ', parsed.killer_faction_id
      ? T('trade.lostBy', { sender, recipient, cargo, killer: nameOfFaction(parsed.killer_faction_id as string | null, undefined) })
      : T('trade.lost', { sender, recipient, cargo }));
  }

  // A kind with no line yet. The machine copy keeps the id; a player is
  // never shown "some_event_key" (playtest R2-C6).
  return out('', en && !opts.names ? ev.kind : ev.kind.replace(/_/g, ' '));
}
