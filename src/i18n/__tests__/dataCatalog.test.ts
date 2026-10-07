// The game-data tables (techs, hulls, parts, traits, emblems, secrets, buildings,
// skins, megastructures) read their names through tk() getters. These tests pin
// three things: the English catalog and the English text written beside each
// table entry never drift apart, every key has a Portuguese entry, and the
// getters follow the language when it flips.
import { setLang } from '../core';
import { data as enData } from '../parts/en/data';
import { data as ptData } from '../parts/pt-BR/data';
import { TECH_DEFS } from '../../game/techs';
import { SHIP_CLASSES } from '../../game/shipClasses';
import { SHIP_PART_DEFS, REPAIR_TENDER_PER_BAY } from '../../game/shipParts';
import { CAPTAIN_TRAITS } from '../../game/captains';
import { EMBLEM_NAMES } from '../../game/emblems';
import { SECRET_DEFS } from '../../game/secrets';
import { BUILDING_DEFS, SETTLEMENT_DEFS } from '../../game/settlements';
import { CITY_SKINS, STATION_SKINS } from '../../game/settlementSkins';
import { MEGASTRUCTURES } from '../../game/megastructures';
import { STRUCTURE_VARIANT_NAMES } from '../../components/StructureIcons';
import { ICON_VARIANT_NAMES, ALL_VARIANTS } from '../../components/ShipIcons';
import { buildStageName } from '../../render/megastructureArt';

const en = enData as Record<string, string>;
const pt = ptData as Record<string, string>;

/** Every [catalog key, live value] pair the tables expose right now. */
function livePairs(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [id, d] of Object.entries(TECH_DEFS)) {
    out.push([`data.tech.${id}.name`, d.name], [`data.tech.${id}.desc`, d.description], [`data.tech.${id}.effect`, d.effectText]);
  }
  for (const d of Object.values(SHIP_CLASSES)) {
    out.push([`data.ship.${d.className}.name`, d.displayName], [`data.ship.${d.className}.desc`, d.description]);
  }
  for (const [id, d] of Object.entries(SHIP_PART_DEFS)) {
    out.push([`data.part.${id}.name`, d.name], [`data.part.${id}.blurb`, d.blurb], [`data.part.${id}.tech`, d.techNote]);
  }
  for (const [id, d] of Object.entries(CAPTAIN_TRAITS)) {
    out.push([`data.trait.${id}.name`, d.name], [`data.trait.${id}.blurb`, d.blurb]);
  }
  for (const [id, n] of Object.entries(EMBLEM_NAMES)) out.push([`data.emblem.${id}`, n]);
  for (const [id, d] of Object.entries(SECRET_DEFS)) {
    out.push([`data.secret.${id}.name`, d.displayName], [`data.secret.${id}.found`, d.discoveryMessage]);
  }
  for (const [id, d] of Object.entries(BUILDING_DEFS)) {
    out.push([`data.building.${id}.name`, d.displayName], [`data.building.${id}.desc`, d.description], [`data.building.${id}.short`, d.effectShort]);
  }
  for (const [id, d] of Object.entries(SETTLEMENT_DEFS)) out.push([`data.settlement.${id}.name`, d.displayName]);
  for (const [kind, list] of [['city', CITY_SKINS], ['station', STATION_SKINS]] as const) {
    for (const s of list) {
      out.push([`data.skin.${kind}.${s.id}.name`, s.name], [`data.skin.${kind}.${s.id}.short`, s.short], [`data.skin.${kind}.${s.id}.blurb`, s.blurb]);
    }
  }
  for (const [id, d] of Object.entries(MEGASTRUCTURES)) {
    out.push([`data.mega.${id}.label`, d.label], [`data.mega.${id}.blurb`, d.blurb]);
  }
  for (const [kind, looks] of Object.entries(STRUCTURE_VARIANT_NAMES)) {
    for (const [v, n] of Object.entries(looks)) out.push([`data.structure.${kind}.${v}`, n as string]);
  }
  for (const names of Object.values(ICON_VARIANT_NAMES)) {
    for (const v of ALL_VARIANTS) {
      const n = names[v];
      if (n) out.push(['data.hull.' + n.toLowerCase().replace(/[^a-z0-9]+/g, '_'), n]);
    }
  }
  for (const [pct, key] of [[0, 'keel'], [0.3, 'frame'], [0.6, 'plating'], [0.9, 'fitting']] as const) {
    out.push([`data.buildStage.${key}.name`, buildStageName(pct)]);
  }
  return out;
}

describe('data catalog', () => {
  afterEach(() => setLang('en', false));

  it('every English key has a Portuguese entry, and no Portuguese key is stray', () => {
    expect(Object.keys(en).filter(k => !(k in pt))).toEqual([]);
    expect(Object.keys(pt).filter(k => !(k in en))).toEqual([]);
  });

  it('English: each table reads exactly the catalog text', () => {
    setLang('en', false);
    const pairs = livePairs();
    expect(pairs.length).toBeGreaterThan(300);
    const wrong = pairs.filter(([k, v]) => {
      const want = k === 'data.part.repair.blurb' ? en[k].replace('{rate}', String(REPAIR_TENDER_PER_BAY)) : en[k];
      return v !== want;
    });
    expect(wrong).toEqual([]);
  });

  it('every key a table reads exists in the catalog', () => {
    setLang('en', false);
    expect(livePairs().map(([k]) => k).filter(k => !(k in en))).toEqual([]);
  });

  it('Portuguese: the same tables follow the language, live', () => {
    setLang('pt-BR', false);
    expect(SHIP_CLASSES.destroyer.displayName).toBe('Destróier');
    expect(SHIP_CLASSES.mobile_foundry.displayName).toBe('Fundição Móvel');
    expect(TECH_DEFS.sensors.name).toBe('Sensores');
    expect(SHIP_PART_DEFS.repair.blurb).toContain(`${REPAIR_TENDER_PER_BAY} HP/turno`);
    expect(MEGASTRUCTURES.warp_gate.label).toBe('Portal de Dobra');
    setLang('en', false);
    expect(SHIP_CLASSES.destroyer.displayName).toBe('Destroyer');
  });

  it('a secret reveal reads without the English DISCOVERY lead-in in Portuguese', () => {
    setLang('pt-BR', false);
    for (const d of Object.values(SECRET_DEFS)) expect(d.discoveryMessage).not.toMatch(/^\s*DISCOVERY/i);
  });
});
