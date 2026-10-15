// The Map Maker's checklist is built in English (the server runs it too);
// the client rebuilds every line from its code + params. A new code in
// checkMap without a translation here would show English to a Portuguese
// player, so every code the checker can emit must translate.

import { setLang } from '../../i18n/core';
import { checkMap, blankMap, type CustomMap, type MapBody, type MapIssue } from '../../game/customMap';
import { issueText, mapApiError, typeLabel } from '../mmText';

const body = (id: string, over: Partial<MapBody> = {}): MapBody => ({
  id, name: id.toUpperCase(), type: 'terrestrial', parent: 'sun', orbit: 300, angle: 0, radius: 3,
  yields: { metal: 3, credits: 3, science: 3 }, color: '#4f8a3c', surface: 'verdant', rings: false, start: false, secret: null,
  ...over,
} as MapBody);

const withBodies = (bodies: MapBody[], extra: Partial<CustomMap> = {}): CustomMap => ({ ...blankMap(), bodies, ...extra });

/** Maps that between them trip every code checkMap knows. */
function everyIssue(): MapIssue[] {
  const maps: CustomMap[] = [
    blankMap(),
    // starts, start_no_science, starts_close, moon_far, names_dup, secrets
    withBodies([
      body('pa', { start: true, yields: { metal: 1, credits: 1, science: 0 } }),
      body('pb', { type: 'moon', parent: 'pa', orbit: 350, radius: 2, start: true, name: 'PA' }),
      body('pc', { orbit: 900, start: true, secret: 'random' }),
      body('pd', { orbit: 1500, start: true, secret: 'resource_cache' }),
    ]),
    // orbits_close, names, resources
    withBodies([body('qa', { orbit: 300 }), body('qb', { orbit: 305 })]),
    // no_resources
    withBodies([body('ra', { yields: { metal: 0, credits: 0, science: 0 } })]),
    // none_metal / none_credits / none_science
    withBodies([body('sa', { yields: { metal: 0, credits: 2, science: 2 } })]),
    withBodies([body('sb', { yields: { metal: 2, credits: 0, science: 2 } })]),
    withBodies([body('sc', { yields: { metal: 2, credits: 2, science: 0 } })]),
    // sectors, sector_empty, sector_loose, sector_names
    withBodies([body('ta', { orbit: 300 }), body('tb', { orbit: 3000 })], {
      sectors: [
        { id: 'sa1', name: 'Same', color: '#4ecdc4', inner: 200, outer: 400 },
        { id: 'sa2', name: 'Same', color: '#ffb84d', inner: 500, outer: 700 },
      ],
    }),
    // sector_starts: two start worlds in one band
    withBodies([
      body('ua', { orbit: 500, start: true, name: 'UA', yields: { metal: 2, credits: 2, science: 3 } }),
      body('ub', { orbit: 520, angle: 3, start: true, name: 'UB', yields: { metal: 2, credits: 2, science: 3 } }),
    ], { sectors: [{ id: 'su1', name: 'Home Ring', color: '#4ecdc4', inner: 400, outer: 700 }] }),
    // max_bodies
    withBodies(Array.from({ length: 200 }, (_, i) => body(`m${i}`, { name: `W${i}`, orbit: 200 + i * 60 }))),
  ];
  const seen = new Map<string, MapIssue>();
  for (const m of maps) for (const i of checkMap(m)) if (!seen.has(i.code)) seen.set(i.code, i);
  return [...seen.values()];
}

describe('Map Maker text', () => {
  afterEach(() => setLang('en', false));

  it('the fixtures reach every checklist code', () => {
    const codes = everyIssue().map(i => i.code).sort();
    expect(codes).toEqual([
      'max_bodies', 'moon_far', 'names', 'names_dup', 'no_resources', 'none_credits', 'none_metal', 'none_science',
      'orbits_close', 'resources', 'secrets', 'sector_empty', 'sector_loose', 'sector_names', 'sector_starts', 'sectors',
      'start_no_science', 'starts', 'starts_close', 'too_few_starts',
    ]);
  });

  it('English readers get the checker\'s own words', () => {
    for (const i of everyIssue()) expect(issueText(i)).toEqual({ title: i.title, detail: i.detail });
  });

  it('every checklist line is rebuilt in Portuguese', () => {
    setLang('pt-BR', false);
    const english = everyIssue().filter(i => {
      const tx = issueText(i);
      return tx.title === i.title || tx.detail === i.detail || /\{\w+\}/.test(tx.title + tx.detail);
    }).map(i => i.code);
    expect(english).toEqual([]);
    const few = checkMap(blankMap()).find(i => i.code === 'too_few_starts')!;
    expect(issueText(few).title).toBe('Mundos iniciais: 0');
  });

  it('labels and server errors follow the language', () => {
    setLang('pt-BR', false);
    expect(typeLabel('gas-giant')).toBe('Gigante gasoso');
    expect(mapApiError({ code: 'bad_code', message: 'a share code looks like ORB-7KQ2-HELN' }, 'mm.start.codeFailed'))
      .toMatch(/código/);
    expect(mapApiError({ code: 'something_new', message: 'new english' }, 'mm.save.failed')).toBe('Não foi possível salvar.');
    setLang('en', false);
    expect(mapApiError({ code: 'something_new', message: 'new english' }, 'mm.save.failed')).toBe('new english');
    expect(typeLabel('gas-giant')).toBe('Gas giant');
  });
});
