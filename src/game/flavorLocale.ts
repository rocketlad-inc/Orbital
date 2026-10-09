// ============================================================
// flavorLocale
//
// Everything the flavor engine builds with ENGLISH GRAMMAR lives
// here, one "lexicon" per language, so flavorEngine.ts itself stays
// language-neutral:
//
//   - the tokens that are not names: ship class, building, settlement
//     type, body type, secret, pact, tech name and level, the vote
//     outcome, the victory detail, the resource list, the population
//     figure, the travel-distance phrase and the leader title;
//   - for Portuguese, the GENDER of each of those nouns, so a template
//     may write "o {shipClass}" / "um {secretName}" and the engine
//     rewrites the article to "a" / "uma" when the noun is feminine
//     (see agreeArticles). Factions, worlds, ships and settlements are
//     NAMES whose gender nobody knows, so Portuguese templates never
//     put an article, adjective or participle across one of those.
//
// The English lexicon is a faithful copy of what flavorEngine.ts did
// inline before translation existed: the golden test pins its output.
// ============================================================

import { catalogs, type Lang } from '../i18n/core';

export type Gender = 'm' | 'f';

/** A noun value plus (Portuguese only) its grammatical gender. */
export interface Noun { text: string; g?: Gender }

export interface FlavorLex {
  leaderTitles: string[];
  /** Bucket an orbit radius into a travel phrase. */
  distance(r: number | null | undefined): string;
  shipClass(raw: string | undefined): Noun | undefined;
  building(raw: string | undefined): Noun | undefined;
  settlementType(raw: string | undefined): Noun;
  bodyType(raw: string | undefined): Noun | undefined;
  secretName(kind: string | undefined): Noun | undefined;
  pactType(kind: string | undefined): string | undefined;
  techName(id: string | undefined, englishName: string | undefined): string | undefined;
  techLevel(level: string | undefined): string | undefined;
  population(units: number): string;
  bundle(b: unknown): string | undefined;
  /** "<offer> for <request>" / one side only / undefined. */
  trade(offer: string | undefined, request: string | undefined): string | undefined;
  voteOutcome(raw: string | undefined): string | undefined;
  victoryDetail(raw: string | undefined): string | undefined;
}

const cap = (s: string): string => s.replace(/^\w/, c => c.toUpperCase());

// ------------------------------------------------------------
// English (byte-for-byte what the engine always did)
// ------------------------------------------------------------

const EN_SECRET_NAME: Record<string, string> = {
  portal_to_sun:    'warp gate',
  warp_gate:        'warp gate',
  ancient_city:     'ancient databank',
  free_collector:   'derelict freight hub',
  pre_terraformed:  'pre-terraformed world',
  derelict_warship: 'derelict warship',
  resource_cache:   'buried resource cache',
};

const EN_PACT_LABEL: Record<string, string> = {
  nap:          'Non-Aggression Pact',
  defense_pact: 'Defense Pact',
  intel_share:  'Intel-Share Pact',
};

// Settlement `population` is an internal game stat (1-10, tracks
// development tier — see src/game/settlements.ts GROWTH_INTERVAL).
// For narrative purposes it stands in for a much larger populace:
// 1 pop = 200,000 people. Purely a display-layer read.
export const POP_PER_UNIT = 200_000;

function formatPopulationEn(units: number): string {
  const people = units * POP_PER_UNIT;
  if (people >= 1_000_000) {
    const millions = people / 1_000_000;
    const str = Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
    return `${str} million`;
  }
  return people.toLocaleString('en-US');
}

function fmtBundleEn(b: unknown): string | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const o = b as Record<string, number>;
  const parts: string[] = [];
  if ((o.metal ?? 0) > 0)   parts.push(`${o.metal} metal`);
  if ((o.fuel ?? 0) > 0)    parts.push(`${o.fuel} fuel`);
  if ((o.gold ?? 0) > 0)    parts.push(`${o.gold} credits`);
  if ((o.science ?? 0) > 0) parts.push(`${o.science} science`);
  return parts.length ? parts.join(', ') : undefined;
}

const EN: FlavorLex = {
  leaderTitles: [
    'Emperor', 'Premier', 'Director', 'First Speaker', 'President',
    'Prime Minister', 'Chancellor', 'Consul', 'Administrator', 'Sovereign',
  ],
  distance(r) {
    if (r == null || !Number.isFinite(r)) return 'across the system';
    // Thresholds are rough relative bands across the seeded system —
    // SCALED with SYSTEM_SCALE in worker/factions.js (the system was
    // spread 2x, so unscaled bands would describe every haul one
    // category too short).
    if (r < 800)  return 'a short hop';
    if (r < 1800) return 'across the inner system';
    if (r < 3600) return 'the long haul to the Belt';
    return 'out past the gas giants';
  },
  shipClass: raw => {
    const s = (raw ?? '').replace(/^\w/, c => c.toUpperCase()) || undefined;
    return s ? { text: s } : undefined;
  },
  building: raw => (raw ? { text: cap(raw) } : undefined),
  settlementType: raw => ({ text: raw ?? 'settlement' }),
  bodyType: raw => (raw != null ? { text: raw } : undefined),
  secretName: kind =>
    (kind ? { text: EN_SECRET_NAME[kind] ?? kind.replace(/_/g, ' ') } : undefined),
  pactType: kind => EN_PACT_LABEL[kind ?? ''] ?? undefined,
  techName: (id, englishName) =>
    englishName ?? (id ? id.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : undefined),
  techLevel: lvl => (lvl != null ? `level ${lvl}` : undefined),
  population: formatPopulationEn,
  bundle: fmtBundleEn,
  trade(offer, request) {
    if (offer && request) return `${offer} for ${request}`;
    return offer ?? request;
  },
  voteOutcome: raw => raw,
  victoryDetail: raw => raw,
};

// ------------------------------------------------------------
// Português (Brasil)
// ------------------------------------------------------------

/** Lower-case the first letter of every word: catalog names are Title
 *  Case ("Nave colonizadora" stays readable, "Mega Destróier" does not
 *  belong mid-sentence). */
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const lowerAll = (s: string): string => s.split(' ').map(lowerFirst).join(' ');

const PT_SHIP_GENDER: Record<string, Gender> = {
  corvette: 'f', frigate: 'f', destroyer: 'm', freighter: 'm', colony: 'f',
  mega_destroyer: 'm', mobile_foundry: 'f', kaiju: 'm',
};

const PT_SETTLEMENT: Record<string, Noun> = {
  city:       { text: 'cidade', g: 'f' },
  station:    { text: 'estação', g: 'f' },
  settlement: { text: 'assentamento', g: 'm' },
};

const PT_BODY_TYPE: Record<string, Noun> = {
  terrestrial: { text: 'mundo rochoso', g: 'm' },
  gas_giant:   { text: 'gigante gasoso', g: 'm' },
  ice_giant:   { text: 'gigante de gelo', g: 'm' },
  moon:        { text: 'lua', g: 'f' },
  dwarf:       { text: 'planeta-anão', g: 'm' },
  asteroid:    { text: 'asteroide', g: 'm' },
  meteoroid:   { text: 'meteoroide', g: 'm' },
  star:        { text: 'estrela', g: 'f' },
  black_hole:  { text: 'buraco negro', g: 'm' },
  lagrange:    { text: 'ponto de Lagrange', g: 'm' },
  megastructure: { text: 'megaestrutura', g: 'f' },
};

// One entry per secret kind the server seeds. These follow the UI
// names (data.secret.*.name) rather than the English flavor table,
// which maps portal_to_sun and ancient_city onto the wrong nouns.
const PT_SECRET: Record<string, Noun> = {
  portal_to_sun:     { text: 'portal estelar antigo', g: 'm' },
  warp_gate:         { text: 'portal de dobra', g: 'm' },
  ancient_city:      { text: 'cidade antiga em ruínas', g: 'f' },
  free_collector:    { text: 'antigo centro logístico', g: 'm' },
  pre_terraformed:   { text: 'mundo pré-terraformado', g: 'm' },
  derelict_warship:  { text: 'nave de guerra abandonada', g: 'f' },
  resource_cache:    { text: 'depósito de recursos enterrado', g: 'm' },
  ancient_databank:  { text: 'banco de dados antigo', g: 'm' },
  ancient_capital:   { text: 'nave capital abandonada', g: 'f' },
  ancient_relay:     { text: 'retransmissor de sensores antigo', g: 'm' },
  ancient_station:   { text: 'estação de armas antiga', g: 'f' },
  far_gate:          { text: 'par de portais antigos', g: 'm' },
  deep_cache:        { text: 'depósito profundo', g: 'm' },
  precursor_orrery:  { text: 'planetário precursor', g: 'm' },
  horizon_archive:   { text: 'arquivo do horizonte', g: 'm' },
};

const PT_PACT_FALLBACK: Record<string, string> = {
  nap:          'Pacto de Não Agressão',
  defense_pact: 'Pacto de Defesa',
  intel_share:  'Pacto de Compartilhamento de Inteligência',
};

function ptCatalog(key: string): string | undefined {
  return (catalogs()['pt-BR'] as Record<string, string | undefined>)[key];
}

function ptNum(n: number): string {
  return String(n).replace('.', ',');
}

function formatPopulationPt(units: number): string {
  const people = units * POP_PER_UNIT;
  if (people >= 1_000_000) {
    const millions = people / 1_000_000;
    const str = Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace('.', ',');
    // Portuguese keeps "milhão" singular up to (but excluding) 2.
    return `${str} ${millions < 2 ? 'milhão' : 'milhões'}`;
  }
  if (people >= 1000 && people % 1000 === 0) return `${people / 1000} mil`;
  return people.toLocaleString('pt-BR');
}

function fmtBundlePt(b: unknown): string | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const o = b as Record<string, number>;
  const parts: string[] = [];
  if ((o.metal ?? 0) > 0)   parts.push(`${ptNum(o.metal)} de metal`);
  if ((o.fuel ?? 0) > 0)    parts.push(`${ptNum(o.fuel)} de combustível`);
  if ((o.gold ?? 0) > 0)    parts.push(`${ptNum(o.gold)} de créditos`);
  if ((o.science ?? 0) > 0) parts.push(`${ptNum(o.science)} de ciência`);
  if (parts.length < 2) return parts[0];
  // "10 de metal e 7 de créditos": the last item takes "e", which also
  // keeps the list apart from the "por" in "<offer> por <request>".
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

const PT: FlavorLex = {
  // Same positions as the English pool, so a faction keeps the "same"
  // title in both languages. All masculine: templates write "o ...".
  leaderTitles: [
    'imperador', 'premiê', 'diretor', 'primeiro orador', 'presidente',
    'primeiro-ministro', 'chanceler', 'cônsul', 'administrador', 'soberano',
  ],
  // Adverbial phrases: every template reads "viajou {distance}",
  // "vieram {distance}", "trocar correspondência {distance}".
  distance(r) {
    if (r == null || !Number.isFinite(r)) return 'pelo sistema';
    if (r < 800)  return 'num salto curto';
    if (r < 1800) return 'pelo sistema interno';
    if (r < 3600) return 'na longa travessia até o Cinturão';
    return 'para além dos gigantes gasosos';
  },
  shipClass(raw) {
    if (!raw) return undefined;
    const name = ptCatalog(`data.ship.${raw}.name`);
    const text = name ? lowerAll(name) : raw.replace(/_/g, ' ');
    return { text, g: PT_SHIP_GENDER[raw] ?? 'm' };
  },
  // "o edifício {building}": the carrier noun keeps this gender-proof
  // (Forja, Escudos, Armas, Laboratório ... are feminine, masculine
  // and plural).
  building(raw) {
    if (!raw) return undefined;
    const name = ptCatalog(`data.building.${raw}.name`);
    return { text: name ?? cap(raw.replace(/_/g, ' ')) };
  },
  settlementType(raw) {
    const key = raw ?? 'settlement';
    return PT_SETTLEMENT[key] ?? { text: key.replace(/_/g, ' '), g: 'm' };
  },
  bodyType(raw) {
    if (raw == null) return undefined;
    return PT_BODY_TYPE[raw] ?? { text: raw.replace(/_/g, ' '), g: 'm' };
  },
  secretName(kind) {
    if (!kind) return undefined;
    return PT_SECRET[kind] ?? { text: kind.replace(/_/g, ' '), g: 'm' };
  },
  pactType: kind => {
    if (!kind) return undefined;
    const key = ({ nap: 'shell.treaty.nap', defense_pact: 'shell.treaty.defense', intel_share: 'shell.treaty.intel' } as Record<string, string>)[kind];
    return key ? (ptCatalog(key) ?? PT_PACT_FALLBACK[kind]) : undefined;
  },
  techName(id, englishName) {
    if (id) {
      const own = ptCatalog(`data.tech.${id}.name`);
      if (own) return own;
    }
    return englishName ?? (id ? cap(id.replace(/_/g, ' ')) : undefined);
  },
  // Always "nível N": templates write "ao {techLevel}" / "no {techLevel}".
  techLevel: lvl => (lvl != null ? `nível ${lvl}` : undefined),
  population: formatPopulationPt,
  bundle: fmtBundlePt,
  trade(offer, request) {
    if (offer && request) return `${offer} por ${request}`;
    return offer ?? request;
  },
  // Invariant verb phrases: no participle to agree with the bill's title.
  voteOutcome(raw) {
    if (raw === 'passed') return 'passou';
    if (raw === 'failed') return 'não passou';
    return raw;
  },
  victoryDetail(raw) {
    // Lower-case on purpose: the templates always embed it mid-sentence
    // (after a dash, a colon or in parentheses), never at the start of one.
    if (!raw) return raw;
    if (raw === 'Dyson Sphere complete') return 'Esfera de Dyson concluída';
    const dom = /^Controls (\d+) of (\d+) worlds \((\d+)%\)$/.exec(raw);
    if (dom) return `controla ${dom[1]} de ${dom[2]} mundos (${dom[3]}%)`;
    const chan = /^(.+) elected Supreme Chancellor by senate vote$/.exec(raw);
    if (chan) return `Chanceler Supremo eleito por voto do Senado: ${chan[1]}`;
    return raw;
  },
};

const LEXICONS: Record<Lang, FlavorLex> = { en: EN, 'pt-BR': PT };

export function lexFor(lang: Lang): FlavorLex {
  return LEXICONS[lang] ?? EN;
}

// ------------------------------------------------------------
// Portuguese article agreement
//
// A template may write the MASCULINE article before a noun token
// ("o {shipClass}", "um {secretName}", "do {settlementType}", "num
// {bodyType}"). When the noun's gender is feminine, the article is
// rewritten ("a", "uma", "da", "numa"). Masculine/unknown: untouched.
// ------------------------------------------------------------

const FEM: Record<string, string> = {
  o: 'a', um: 'uma', do: 'da', dum: 'duma', no: 'na', num: 'numa',
  ao: 'à', pelo: 'pela', deste: 'desta', neste: 'nesta', este: 'esta',
  esse: 'essa', nesse: 'nessa', aquele: 'aquela',
};
const ARTICLE_ALT = Object.keys(FEM).join('|');

export function agreeArticles(tpl: string, genders: Record<string, Gender>): string {
  let out = tpl;
  for (const key of Object.keys(genders)) {
    if (genders[key] !== 'f') continue;
    const re = new RegExp(`(^|[^\\p{L}])(${ARTICLE_ALT})(\\s+)(?=\\{${key}\\})`, 'giu');
    out = out.replace(re, (_m, pre: string, art: string, sp: string) => {
      const fem = FEM[art.toLowerCase()];
      const cased = art[0] === art[0].toUpperCase() && art[0] !== art[0].toLowerCase()
        ? fem.charAt(0).toUpperCase() + fem.slice(1) : fem;
      return `${pre}${cased}${sp}`;
    });
  }
  return out;
}
