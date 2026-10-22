// ============================================================
// filmCaptions — the match film's words, from the event log.
//
// Every caption the film shows is built from a chronicle row the
// players were sent during the match (public rows only; the server
// filters with FILM_CHRONICLE_KINDS), worded by the event log's own
// formatter so a caption reads exactly as the log did, in the viewer's
// language. This file decides two things per row:
//
//   WEIGHT   how much the moment deserves the screen. 0 = it may run in
//            a montage's ticker but never gets a scene of its own;
//            absent = dropped (bookkeeping such as "settlement founded"
//            happens hundreds of times a match).
//   WHERE    the world the camera should go to, when it is one the film
//            can draw at that tick.
//
// And it words each scene: a KICKER (what kind of moment), a TITLE (the
// moment in a few words) and a SUB (the log line, or the numbers).
// ============================================================

import type { MatchSummary } from './matchWorld';
import type { ReelBeat, ReelScene, ReelBattle } from './filmReel';
import { formatChronicleEvent } from '../multiplayer/eventText';
import { tIn, type Key, type Lang } from '../i18n/core';

export type ChronicleRow = NonNullable<MatchSummary['chronicle']>[number];

export interface Caption {
  kicker: string;
  title: string;
  sub: string;
  /** Whose colour the caption wears, if anyone's. */
  fid: string | null;
}

type P = Record<string, unknown>;

/** Screen weight per kind; see the header. A function may read the row. */
const WEIGHT: Record<string, number | ((p: P, r: ChronicleRow) => number)> = {
  war_declared: 85, war_ended: 40, treaty_signed: 18, treaty_broken: 70,
  settlement_seized: (p) => (p.settlement_type === 'city' ? 120 : 75),
  settlement_destroyed: (p) => (p.is_capital ? 120 : p.settlement_type === 'city' ? 60 : 30),
  settlement_razed: 60,
  settlement_built: 0,
  faction_eliminated: 150, faction_revived: 60, faction_joined: 30, faction_comeback: 130,
  captain_lost: 0,
  kaiju_omen: 70, kaiju_launched: 120, kaiju_revealed: 110, kaiju_hunting: 100,
  kaiju_charging: 140, kaiju_leaving: 60, kaiju_gone: 60,
  // The payoff outranks every setup: the kill is the shareable moment.
  kaiju_dead: 200,
  sun_gate_omen: 45, sun_gate_emerged: 90, sun_gate_opened: 100,
  megastructure_complete: 60, megastructure_claimed: 50,
  megastructure_captured: 95, megastructure_destroyed: 95,
  dyson_initiated: 90, dyson_milestone: 55, dyson_collapsed: 120,
  terraform_complete: 30,
  terraform_destroyed: (p) => (p.cause === 'kaiju' || p.cause === 'mega_destroyer' ? 150 : 90),
  world_obliterated: (p) => (p.cause === 'kaiju' ? 175 : 160),
  mega_strike_charging: 120, asteroid_launched: 60, asteroid_impact: 130, missile_strike: 70,
  secret_discovered: 35,
  // The vote that names a Chancellor can end the match: it is the
  // Senate's whole story in one scene.
  senate_vote: (p) => (p.outcome !== 'passed' ? 25 : p.bill_kind === 'chancellor_vote' ? 165 : 55),
};

/**
 * HOW THE MATCH WAS WON is the film's spine: the moments that built the
 * win get the screen ahead of moments of equal size that did not. A
 * Dyson Sphere victory with no Dyson Sphere in it, or a Senate win with
 * no Senate, is an ending without a story.
 */
const VICTORY_KINDS: Record<string, RegExp> = {
  engineering: /^dyson_/,
  chancellor: /^senate_vote$/,
  senate: /^senate_vote$/,
  annihilation: /^(faction_eliminated|settlement_(seized|destroyed))$/,
  domination: /^settlement_seized$/,
};
const VICTORY_BONUS = 60;
/** The winner's own moments, a little ahead of everyone else's. */
const WINNER_BONUS = 15;

/** Kinds that are about the whole system, never one world. */
const SYSTEM_WIDE = new Set([
  'war_declared', 'war_ended', 'treaty_signed', 'treaty_broken',
  'faction_eliminated', 'faction_revived', 'faction_joined', 'senate_vote', 'kaiju_omen',
]);

function parse(r: ChronicleRow): P {
  try {
    const j = JSON.parse(r.payload || '{}');
    return j && typeof j === 'object' ? j as P : {};
  } catch { return {}; }
}

/** The log line without its "T+12  ⚔️ " head: a caption has its own clock. */
export function bareLine(line: string): string {
  return line.replace(/^T\+\d+\s+/, '').replace(/^[^\p{L}\p{N}"'«(]+/u, '').trim();
}

export interface BeatOptions {
  lang: Lang;
  /** Can the film draw this world at this tick? */
  drawable: (bodyId: string, tick: number) => boolean;
}

/** Every captionable row, weighed and placed. Rows of unknown kinds are dropped. */
export function buildBeats(summary: MatchSummary, o: BeatOptions): ReelBeat[] {
  const names = new Map(summary.factions.map(f => [f.id, f.name]));
  const out: ReelBeat[] = [];
  let firstWar = true;
  /** Empires the log has knocked out, and not (yet) back. */
  const fallen = new Set<string>();
  for (const r0 of summary.chronicle ?? []) {
    let r = r0;
    if (r.kind === 'faction_eliminated' && r.actor_faction_id) fallen.add(r.actor_faction_id);
    // A COMEBACK. An empire the log called out that founds a new world is
    // back in the war; the log only says "settlement founded", which the
    // film would never show, and so the knocked-out empire went on to win
    // every battle in the film unexplained.
    if (r.kind === 'settlement_built' && r.actor_faction_id && fallen.has(r.actor_faction_id)) {
      fallen.delete(r.actor_faction_id);
      r = { ...r, kind: 'faction_comeback' };
    }
    if (r.kind === 'faction_revived' && r.actor_faction_id) fallen.delete(r.actor_faction_id);
    const wDef = WEIGHT[r.kind];
    if (wDef === undefined) continue;
    const p = parse(r);
    let weight = typeof wDef === 'function' ? wDef(p, r) : wDef;
    // The first war is the match turning; later ones are the war going on.
    if (r.kind === 'war_declared') { if (firstWar) weight += 35; firstWar = false; }
    const how = VICTORY_KINDS[summary.game.victory_type ?? ''];
    if (weight > 0 && how?.test(r.kind)) weight += VICTORY_BONUS;
    const winner = summary.game.winner_faction_id;
    if (weight > 0 && winner && r.actor_faction_id === winner) weight += WINNER_BONUS;
    let body: string | null = null;
    if (!SYSTEM_WIDE.has(r.kind) && r.body_id && o.drawable(r.body_id, r.tick_number)) {
      body = r.body_id;
    }
    // A world-bound moment with no world to show is a ticker line.
    if (!body && !SYSTEM_WIDE.has(r.kind) && weight > 0) weight = Math.min(weight, 0);
    const text = bareLine(formatChronicleEvent(
      { tick_number: r.tick_number, kind: r.kind, payload: r.payload,
        actor_faction_id: r.actor_faction_id, target_faction_id: r.target_faction_id },
      { factionNameById: names }, o.lang, { names: true }));
    const beat: ReelBeat = { tick: r.tick_number, kind: r.kind, body, weight,
      fid: r.actor_faction_id ?? null, target: r.target_faction_id ?? null, text, data: p };
    // The log has no sentence of its own for some kinds (wars: the story
    // view words those itself, and so does the film).
    if (text === r.kind) {
      const fname = (id: string | null | undefined) => (id && names.get(id)) || '';
      const bname = (id: string | null | undefined) =>
        (id && summary.bodies.find(b => b.id === id)?.name) || '';
      beat.text = '';
      beat.text = beatCaption(beat,
        (k, v) => tIn(o.lang, `replay.film.${k}` as Key, v), fname, bname).title;
    }
    out.push(beat);
  }
  return mergeBeats(out, summary, o.lang);
}

/**
 * Rows that are one moment on screen:
 *  - wars one empire declares on several rivals in the same tick are
 *    ONE declaration ("declares war on 3 empires");
 *  - a capital destroyed and seized in the same tick is a CAPTURE, not
 *    ruins: the seizure carries the headline and the capital's weight.
 */
function mergeBeats(beats: ReelBeat[], summary: MatchSummary, lang: Lang): ReelBeat[] {
  const T = (k: string, v?: Record<string, string | number>) => tIn(lang, `replay.film.${k}` as Key, v);
  const names = new Map(summary.factions.map(f => [f.id, f.name]));
  const out: ReelBeat[] = [];
  const wars = new Map<string, ReelBeat>();
  for (const e of beats) {
    if (e.kind === 'war_declared') {
      const k = `${e.fid}@${e.tick}`;
      const head = wars.get(k);
      if (head) {
        const n = (Number(head.data?.targets) || 1) + 1;
        head.data = { ...head.data, targets: n };
        head.text = T('title.warMany', { a: names.get(head.fid ?? '') ?? '', n });
        continue;
      }
      wars.set(k, e);
    }
    out.push(e);
  }
  for (const e of out) {
    if (e.kind !== 'settlement_destroyed' || !e.data?.is_capital || !e.body) continue;
    const taken = out.find(x => x.kind === 'settlement_seized' && x.body === e.body
      && Math.abs(x.tick - e.tick) <= 1);
    if (!taken) continue;
    taken.weight = Math.max(taken.weight, e.weight + 10);
    taken.data = { ...taken.data, capital: true, from_name: names.get(e.fid ?? '') ?? '' };
    e.weight = 0;
  }
  // A comeback that knocks someone else out is one moment, told whole:
  // the rise is the headline, the fall its line underneath.
  for (const e of out) {
    if (e.kind !== 'faction_comeback') continue;
    const fell = out.find(x => x.kind === 'faction_eliminated' && x.fid !== e.fid
      && Math.abs(x.tick - e.tick) <= 2 && x.weight > 0);
    if (!fell) continue;
    e.weight = Math.max(e.weight, fell.weight + 10);
    e.data = { ...e.data, line: fell.text };
    fell.weight = 0;
  }
  return out;
}

export interface CaptionCtx {
  lang: Lang;
  summary: MatchSummary;
  /** The empire leading at a tick, with its worlds and ships. */
  leaderAt: (tick: number) => { fid: string; worlds: number; ships: number } | null;
  winner: string | null;
}

const KICK: Record<string, string> = {
  war_declared: 'war', war_ended: 'peace', treaty_signed: 'peace', treaty_broken: 'war',
  settlement_seized: 'conquest', settlement_destroyed: 'ruin', settlement_razed: 'ruin',
  faction_eliminated: 'eliminated', faction_revived: 'comeback', faction_joined: 'world',
  faction_comeback: 'comeback',
  captain_lost: 'captain',
  kaiju_omen: 'leviathan', kaiju_launched: 'leviathan', kaiju_revealed: 'leviathan',
  kaiju_hunting: 'leviathan', kaiju_charging: 'leviathan', kaiju_leaving: 'leviathan',
  kaiju_gone: 'leviathan', kaiju_dead: 'leviathan',
  sun_gate_omen: 'gate', sun_gate_emerged: 'gate', sun_gate_opened: 'gate',
  megastructure_complete: 'mega', megastructure_claimed: 'mega',
  megastructure_captured: 'mega', megastructure_destroyed: 'mega',
  dyson_initiated: 'dyson', dyson_milestone: 'dyson', dyson_collapsed: 'dyson',
  terraform_complete: 'world', terraform_destroyed: 'strike', world_obliterated: 'strike',
  mega_strike_charging: 'strike', asteroid_launched: 'impact', asteroid_impact: 'impact',
  missile_strike: 'missiles', secret_discovered: 'discovery', senate_vote: 'senate',
};

/** The words for a scene. */
export function captionFor(scene: ReelScene, c: CaptionCtx): Caption {
  const T = (k: string, vars?: Record<string, string | number>) =>
    tIn(c.lang, `replay.film.${k}` as Key, vars);
  const fname = (id: string | null | undefined) =>
    (id && c.summary.factions.find(f => f.id === id)?.name) || '';
  const bname = (id: string | null | undefined) =>
    (id && c.summary.bodies.find(b => b.id === id)?.name) || '';

  if (scene.kind === 'intro') {
    const n = c.summary.factions.filter(f => !/:leviathan_f$/.test(f.id)).length;
    const ticks = Math.max(0, (c.summary.ticks.hi ?? 0) - (c.summary.ticks.lo ?? 0));
    return { kicker: T('intro.kicker'),
      title: c.summary.game.name || T('intro.untitled'),
      sub: T('intro.sub', { n, ticks }), fid: null };
  }
  if (scene.kind === 'finale') {
    const champ = c.winner;
    const lead = champ ? null : c.leaderAt(scene.from);
    const ticks = Math.max(0, (c.summary.ticks.hi ?? 0) - (c.summary.ticks.lo ?? 0));
    const vic = (c.summary.chronicle ?? []).find(r => r.kind === 'victory');
    let sub = T('sub.victory', { ticks });
    if (vic) {
      // The log's own victory line, in the viewer's language.
      const names = new Map(c.summary.factions.map(f => [f.id, f.name]));
      const line = bareLine(formatChronicleEvent(
        { tick_number: vic.tick_number, kind: vic.kind, payload: vic.payload,
          actor_faction_id: vic.actor_faction_id, target_faction_id: vic.target_faction_id },
        { factionNameById: names }, c.lang, { names: true }));
      // "GAME OVER — X wins: X elected Chancellor" names the winner the
      // title already names: keep the reason only.
      const reason = line.includes(': ') ? line.slice(line.indexOf(': ') + 2) : line;
      if (reason) sub = `${reason} · ${sub}`;
    }
    // No winner: a match that ended with nobody standing, or one still
    // running. Say who is ahead, or that no one is.
    if (!champ) {
      return { kicker: T('kicker.final'),
        title: lead ? T('title.leads', { a: fname(lead.fid) }) : T('title.noVictor'),
        sub: T('sub.victory', { ticks }), fid: lead?.fid ?? null };
    }
    return { kicker: T('kicker.victory'), title: T('title.victory', { a: fname(champ) }),
      sub, fid: champ };
  }
  if (scene.kind === 'battle' && scene.battle) {
    return battleCaption(scene.battle, T, fname, bname);
  }
  if (scene.kind === 'montage') {
    const lead = c.leaderAt(Math.floor((scene.from + scene.to) / 2));
    const first = scene.from <= (c.summary.ticks.lo ?? 0) + 1;
    return { kicker: T(first ? 'kicker.start' : 'kicker.fastForward'),
      title: lead ? T('title.leads', { a: fname(lead.fid) }) : '',
      sub: lead ? T('sub.leads', { worlds: lead.worlds, ships: lead.ships }) : '',
      fid: lead?.fid ?? null };
  }
  const e = scene.beat;
  if (!e) return { kicker: '', title: '', sub: '', fid: null };
  return beatCaption(e, T, fname, bname);
}

function battleCaption(b: ReelBattle,
  T: (k: string, v?: Record<string, string | number>) => string,
  fname: (id: string | null | undefined) => string,
  bname: (id: string | null | undefined) => string): Caption {
  const [a, bb] = b.sides;
  const more = Math.max(0, (b.present ?? 2) - 2);
  const sub = a && bb && more > 0
    ? T('sub.battleMany', { a: fname(a), b: fname(bb), more, n: b.peak, lost: b.lost })
    : a && bb
    ? T('sub.battle', { a: fname(a), b: fname(bb), n: b.peak, lost: b.lost })
    : T('sub.battleOne', { a: fname(a) || '?', n: b.peak, lost: b.lost });
  return { kicker: T('kicker.battle'), title: T('title.battle', { world: bname(b.body) }),
    sub, fid: a ?? null };
}

/** A beat's kicker, title and sub. The sub is always the log line. */
export function beatCaption(e: ReelBeat,
  T: (k: string, v?: Record<string, string | number>) => string,
  fname: (id: string | null | undefined) => string,
  bname: (id: string | null | undefined) => string): Caption {
  const p = (e.data ?? {}) as P;
  const a = fname(e.fid), b = fname(e.target);
  const world = String(p.body_name ?? p.world ?? bname(e.body) ?? '');
  const kick = e.kind === 'settlement_destroyed' && p.is_capital ? 'capital'
    : e.kind === 'settlement_seized' && p.capital ? 'capital'
    : (e.kind === 'terraform_destroyed' || e.kind === 'world_obliterated') && p.cause === 'kaiju' ? 'leviathan'
    : KICK[e.kind];
  const kicker = kick ? T(`kicker.${kick}`) : '';
  let title = '';
  switch (e.kind) {
    case 'war_declared':
      title = Number(p.targets) > 1 ? T('title.warMany', { a, n: Number(p.targets) })
        : T('title.war', { a, b });
      break;
    case 'war_ended': title = T('title.peace', { a, b }); break;
    case 'treaty_signed': title = T('title.treaty', { a, b }); break;
    case 'treaty_broken': title = T('title.treatyBroken', { a, b }); break;
    case 'settlement_seized':
      title = p.capital ? T('title.seizedCapital', { world, a }) : T('title.seized', { world, a });
      break;
    case 'settlement_destroyed':
      title = p.is_capital ? T('title.capitalFalls', { a, world }) : T('title.destroyed', { world });
      break;
    case 'settlement_razed': title = T('title.destroyed', { world }); break;
    case 'faction_eliminated':
      title = T('title.eliminated', { a: String(p.faction_name ?? a) }); break;
    case 'faction_comeback': case 'faction_revived':
      title = T('title.comeback', { a, world }); break;
    case 'kaiju_omen': title = T('title.kaijuOmen'); break;
    case 'kaiju_launched': title = T('title.kaijuComes'); break;
    case 'kaiju_hunting': title = T('title.kaijuHunts', { world }); break;
    case 'kaiju_revealed': case 'kaiju_charging': title = T('title.kaijuFeeds', { world }); break;
    case 'kaiju_dead': title = T('title.kaijuDead'); break;
    case 'kaiju_leaving': case 'kaiju_gone': title = T('title.kaijuGone'); break;
    case 'sun_gate_omen': case 'sun_gate_emerged': title = T('title.gateRises'); break;
    case 'sun_gate_opened': title = T('title.gateOpens', { gate: String(p.gate ?? '') }); break;
    case 'megastructure_complete': case 'megastructure_claimed':
      title = T('title.megaBuilt', { structure: String(p.structure ?? '') }); break;
    case 'megastructure_captured': title = T('title.megaTaken', { structure: String(p.structure ?? '') }); break;
    case 'megastructure_destroyed': title = T('title.megaLost', { structure: String(p.structure ?? '') }); break;
    case 'dyson_initiated': title = T('title.dysonBegun', { a: String(p.faction_name ?? a) }); break;
    case 'dyson_milestone': title = T('title.dysonRises'); break;
    case 'dyson_collapsed': title = T('title.dysonFalls'); break;
    case 'mega_strike_charging': title = T('title.strikeAimed', { world }); break;
    case 'terraform_destroyed':
      title = p.cause === 'kaiju' ? T('title.devoured', { world }) : T('title.sterilised', { world }); break;
    case 'world_obliterated':
      title = p.cause === 'kaiju' ? T('title.devoured', { world }) : T('title.obliterated', { world }); break;
    case 'asteroid_launched': case 'asteroid_impact': title = T('title.impact', { world }); break;
    case 'missile_strike': title = T('title.missiles', { world }); break;
    case 'terraform_complete': title = T('title.living', { world }); break;
    case 'secret_discovered': title = T('title.discovery', { world }); break;
    case 'captain_lost': title = T('title.captain', { name: String(p.captain_name ?? '') }); break;
    case 'senate_vote': {
      const inner = (p.payload ?? {}) as P;
      title = p.bill_kind === 'chancellor_vote'
        ? T('title.chancellor', { a: fname(String(inner.candidate_faction_id ?? '')) || a })
        : T('title.senate', { title: String(p.title ?? '') });
      break;
    }
    default: title = e.text; break;
  }
  const line = typeof p.line === 'string' ? p.line : e.text;
  const sub = title === line ? '' : line.replace(/\s*\[[^\]]*\]/g, '');
  return { kicker, title, sub, fid: e.fid };
}
