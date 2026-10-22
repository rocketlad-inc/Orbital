// The match film's edit (filmReel) and its words (filmCaptions).
import {
  battleWindow, filmSecondsAt, planReel, reelBudget, reelRate, reelSeconds,
  type ReelBattle, type ReelBeat,
} from '../filmReel';
import { bareLine, buildBeats } from '../filmCaptions';
import type { MatchSummary } from '../matchWorld';

const battle = (body: string, from: number, to: number, peak: number, lost: number): ReelBattle =>
  ({ body, from, to, peak, lost, sides: ['a', 'b'], window: [from, Math.min(to, from + 8)] });
const beat = (tick: number, kind: string, weight: number, body: string | null = null): ReelBeat =>
  ({ tick, kind, body, weight, fid: 'a', target: 'b', text: `${kind} at ${tick}` });

describe('filmReel', () => {
  it('budgets a share-length film, growing gently with the match', () => {
    expect(reelBudget(20)).toBe(42);
    expect(reelBudget(500)).toBe(63);
    expect(reelBudget(5000)).toBe(72);
  });

  it('finds the deadliest stretch of a long fight', () => {
    const deaths: Record<number, number> = { 30: 5, 31: 6, 12: 1 };
    expect(battleWindow(10, 40, t => deaths[t] ?? 0, 4)).toEqual([28, 32]);
    // A short fight is shown whole.
    expect(battleWindow(10, 13, () => 0, 8)).toEqual([10, 13]);
  });

  it('covers every tick once, in order, bookended by intro and finale', () => {
    const scenes = planReel({ lo: 1, hi: 300,
      battles: [battle('mars', 40, 60, 40, 12), battle('earth', 200, 210, 80, 30)],
      beats: [beat(120, 'faction_eliminated', 150), beat(250, 'war_declared', 85)] });
    expect(scenes[0].kind).toBe('intro');
    expect(scenes[scenes.length - 1].kind).toBe('finale');
    expect(scenes[0].from).toBe(1);
    expect(scenes[scenes.length - 1].to).toBe(300);
    for (let i = 1; i < scenes.length; i++) expect(scenes[i].from).toBe(scenes[i - 1].to);
    for (const s of scenes) expect(s.to).toBeGreaterThan(s.from);
  });

  it('keeps to its budget, and the clock agrees with it', () => {
    const battles = Array.from({ length: 30 }, (_, i) => battle(`w${i}`, 10 + i * 15, 18 + i * 15, 20 + i, 5 + i));
    const scenes = planReel({ lo: 1, hi: 480, battles, beats: [] });
    const total = reelSeconds(scenes);
    expect(total).toBeLessThanOrEqual(reelBudget(479) + 2);
    let sum = 0;
    for (let t = 1; t < 480; t++) sum += reelRate(scenes, t);
    expect(sum).toBeCloseTo(total, 5);
    expect(filmSecondsAt(scenes, 480)).toBeCloseTo(total, 5);
  });

  it('weighs a headline against the biggest battle, not below every battle', () => {
    const battles = Array.from({ length: 12 }, (_, i) => battle(`w${i}`, 20 + i * 30, 28 + i * 30, 200, 60));
    const scenes = planReel({ lo: 1, hi: 400, battles,
      beats: [beat(380, 'kaiju_dead', 160, 'weywot')] });
    expect(scenes.some(s => s.kind === 'beat' && s.beat?.kind === 'kaiju_dead')).toBe(true);
  });

  it('prefers a new place to a third visit to the same one', () => {
    const battles = [10, 60, 110, 160].map(t => battle('earth', t, t + 8, 100, 30))
      .concat([{ ...battle('mars', 210, 218, 60, 12), sides: ['c', 'd'] }]);
    const scenes = planReel({ lo: 1, hi: 260, battles, beats: [] }, { targetSeconds: 50 });
    const places = scenes.filter(s => s.kind === 'battle').map(s => s.bodyId);
    expect(places).toContain('mars');
  });

  it('bends a battle around a headline on its last tick instead of dropping it', () => {
    const scenes = planReel({ lo: 1, hi: 120,
      battles: [battle('earth', 100, 108, 120, 30)],
      beats: [beat(107, 'senate_vote', 240)] });
    const fight = scenes.find(s => s.kind === 'battle');
    expect(fight?.bodyId).toBe('earth');
    expect(scenes.some(s => s.kind === 'beat')).toBe(true);
  });

  it('leaves standoffs where nobody died out of the cut', () => {
    const scenes = planReel({ lo: 1, hi: 100,
      battles: [battle('mars', 20, 28, 90, 0)], beats: [] });
    expect(scenes.some(s => s.kind === 'battle')).toBe(false);
  });

  it('runs the minor headlines in the scene they fall in', () => {
    const scenes = planReel({ lo: 1, hi: 100, battles: [],
      beats: [beat(50, 'settlement_built', 0)] });
    const host = scenes.find(s => 50 >= s.from && 50 < s.to)!;
    expect(host.extras.map(e => e.kind)).toEqual(['settlement_built']);
  });
});

describe('filmCaptions', () => {
  it('strips the clock and the glyph from a log line', () => {
    expect(bareLine('T+12  ☠ Red is out')).toBe('Red is out');
    expect(bareLine('T+3  Titan falls')).toBe('Titan falls');
  });

  const summary = {
    game: { id: 'g', name: 'Test', status: 'completed', winner_faction_id: null, victory_type: null },
    ticks: { lo: 1, hi: 50, rows: 50 },
    factions: [{ id: 'g:f0', name: 'Red', color: '#f00', color2: null },
      { id: 'g:f1', name: 'Blue', color: '#00f', color2: null }],
    bodies: [{ id: 'g:mars', name: 'Mars' }],
    battles: [],
    chronicle: [
      { tick_number: 5, kind: 'war_declared', payload: '{}', actor_faction_id: 'g:f0', target_faction_id: 'g:f1', body_id: null },
      { tick_number: 9, kind: 'war_declared', payload: '{}', actor_faction_id: 'g:f1', target_faction_id: 'g:f0', body_id: null },
      { tick_number: 12, kind: 'settlement_seized', payload: '{"body_name":"Mars","settlement_type":"city"}',
        actor_faction_id: 'g:f0', target_faction_id: 'g:f1', body_id: 'g:mars' },
      { tick_number: 14, kind: 'settlement_seized', payload: '{"body_name":"Mars"}',
        actor_faction_id: 'g:f1', target_faction_id: 'g:f0', body_id: 'g:mars' },
      { tick_number: 20, kind: 'ship_built', payload: '{}', actor_faction_id: 'g:f0', target_faction_id: null, body_id: null },
    ],
  } as unknown as MatchSummary;

  it('weighs the first war above the later ones, and words wars itself', () => {
    const beats = buildBeats(summary, { lang: 'en', drawable: () => true });
    const wars = beats.filter(b => b.kind === 'war_declared');
    expect(wars[0].weight).toBeGreaterThan(wars[1].weight);
    expect(wars[0].text).toBe('Red declares war on Blue');
  });

  it('drops bookkeeping kinds and keeps the log line for the rest', () => {
    const beats = buildBeats(summary, { lang: 'en', drawable: () => true });
    expect(beats.some(b => b.kind === 'ship_built')).toBe(false);
    const seized = beats.filter(b => b.kind === 'settlement_seized');
    expect(seized[0].body).toBe('g:mars');
    expect(seized[0].weight).toBeGreaterThan(seized[1].weight);
    expect(seized[0].text).toMatch(/Mars/);
  });

  it('makes one beat of wars declared on several rivals at once', () => {
    const s = { ...summary, factions: [...summary.factions, { id: 'g:f2', name: 'Gold', color: '#ff0', color2: null }],
      chronicle: [
        { tick_number: 5, kind: 'war_declared', payload: '{}', actor_faction_id: 'g:f0', target_faction_id: 'g:f1', body_id: null },
        { tick_number: 5, kind: 'war_declared', payload: '{}', actor_faction_id: 'g:f0', target_faction_id: 'g:f2', body_id: null },
      ] } as unknown as MatchSummary;
    const wars = buildBeats(s, { lang: 'en', drawable: () => true });
    expect(wars).toHaveLength(1);
    expect(wars[0].text).toBe('Red declares war on 2 empires');
  });

  it('reads a capital destroyed and seized in one tick as a capture', () => {
    const s = { ...summary, chronicle: [
      { tick_number: 12, kind: 'settlement_destroyed', payload: '{"body_name":"Mars","is_capital":true}',
        actor_faction_id: 'g:f1', target_faction_id: null, body_id: 'g:mars' },
      { tick_number: 12, kind: 'settlement_seized', payload: '{"body_name":"Mars"}',
        actor_faction_id: 'g:f0', target_faction_id: null, body_id: 'g:mars' },
    ] } as unknown as MatchSummary;
    const [ruin, take] = buildBeats(s, { lang: 'en', drawable: () => true });
    expect(ruin.weight).toBe(0);
    expect(take.weight).toBeGreaterThan(120);
    expect(take.data?.capital).toBe(true);
  });

  it('makes one campaign of world after world taken by one empire', () => {
    const seized = (t: number, w: string) => ({ tick_number: t, kind: 'settlement_seized',
      payload: JSON.stringify({ body_name: w }), actor_faction_id: 'g:f0', target_faction_id: null, body_id: `g:${w}` });
    const s = { ...summary, bodies: [{ id: 'g:mars', name: 'Mars' }, { id: 'g:io', name: 'Io' }, { id: 'g:ceres', name: 'Ceres' }],
      chronicle: [seized(10, 'mars'), seized(20, 'io'), seized(24, 'mars'), seized(30, 'ceres'), seized(90, 'io')] } as unknown as MatchSummary;
    const beats = buildBeats(s, { lang: 'en', drawable: () => true }).filter(b => b.weight > 0);
    // Ten to thirty is one campaign over three worlds; ninety stands alone.
    expect(beats).toHaveLength(2);
    expect(beats[0].data?.campaign).toEqual(['mars', 'io', 'ceres']);
    expect(beats[1].tick).toBe(90);
  });

  it('puts the moments that won the match ahead of their equals', () => {
    const s = { ...summary, game: { ...summary.game, victory_type: 'engineering', winner_faction_id: 'g:f0' },
      chronicle: [
        { tick_number: 30, kind: 'dyson_milestone', payload: '{"pct":50}', actor_faction_id: 'g:f0', target_faction_id: null, body_id: 'g:mars' },
        { tick_number: 31, kind: 'senate_vote', payload: '{"outcome":"passed"}', actor_faction_id: 'g:f1', target_faction_id: null, body_id: null },
      ] } as unknown as MatchSummary;
    const [dyson, senate] = buildBeats(s, { lang: 'en', drawable: () => true });
    expect(dyson.weight).toBeGreaterThan(senate.weight + 60);
  });

  it('demotes a world-bound headline it cannot show to the ticker', () => {
    const beats = buildBeats(summary, { lang: 'en', drawable: () => false });
    expect(beats.filter(b => b.kind === 'settlement_seized').every(b => b.weight <= 0)).toBe(true);
  });
});
