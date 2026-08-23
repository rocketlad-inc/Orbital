// THE CLIENT AND SERVER MUST SEE THE SAME DISTANCE.
//
// Sensor reach exists twice: worker/state.js decides which ships make it
// into the payload, and src/game/visibility.ts decides which of those
// the client keeps and how big a ring it draws. Both started from the
// same table with the same hard-coded x2.
//
// Then system_scale became per-game. The server learned to multiply by
// it; this file did not. At system_scale 4 the server revealed ships out
// to 3,200 units and the client threw them away at 800 — a quarter of
// the vision the player had, invisibly, because the tighter of two
// filters wins and neither one logs. The map is 24,000 units across at
// that scale, so a station was covering 0.11% of the board instead of
// 1.78%.
//
// Two things are asserted: the base tables still match line for line,
// and the client actually APPLIES a scale it is handed.

import fs from 'fs';
import path from 'path';
import {
  SHIP_SENSOR_RANGE, SETTLEMENT_SENSOR_RANGE,
  setSensorScale, sensorScale, shipSensorRange, settlementSensorRangeFor,
} from '../visibility';

const server = fs.readFileSync(
  path.resolve(__dirname, '../../..', 'worker/state.js'), 'utf8',
);

/** `const NAME = <number>` out of the server bundle. */
function num(src: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)`).exec(src);
  if (!m) throw new Error(`could not find ${name} in worker/state.js`);
  return Number(m[1]);
}

/** `key: <base> * SENSOR_SCALE` pairs out of a server table literal.
 *  Anchored on the DECLARATION, not the first mention — the file names
 *  both tables in a KEEP IN SYNC comment fourteen lines above them. */
function table(src: string, name: string): Record<string, number> {
  const i = src.indexOf(`const ${name} = {`);
  if (i < 0) throw new Error(`no declaration of ${name}`);
  const block = src.slice(i, src.indexOf('};', i));
  const out: Record<string, number> = {};
  for (const m of block.matchAll(/(\w+):\s*([\d.]+)\s*\*\s*SENSOR_SCALE/g)) {
    out[m[1]] = Number(m[2]) * num(src, 'const SENSOR_SCALE');
  }
  return out;
}

afterEach(() => setSensorScale(1));

describe('base tables match the server', () => {
  it('the same SENSOR_SCALE on both sides', () => {
    // Parsed from this file's own source so the check cannot be fooled
    // by the accessor: the BASE constant is what has to agree.
    const client = fs.readFileSync(
      path.resolve(__dirname, '..', 'visibility.ts'), 'utf8',
    );
    expect(num(client, 'const SENSOR_SCALE')).toBe(num(server, 'const SENSOR_SCALE'));
  });

  it('ship ranges match', () => {
    const srv = table(server, 'SHIP_SENSOR_RANGE');
    expect(Object.keys(srv).length).toBeGreaterThanOrEqual(5);
    expect(SHIP_SENSOR_RANGE).toEqual(srv);
  });

  it('settlement ranges match', () => {
    const srv = table(server, 'SETTLEMENT_SENSOR_RANGE');
    expect(Object.keys(srv).length).toBeGreaterThanOrEqual(2);
    expect(SETTLEMENT_SENSOR_RANGE).toEqual(srv);
  });
});

describe('the client applies the scale the server hands it', () => {
  it('defaults to 1, so an un-plumbed board is unchanged', () => {
    expect(sensorScale()).toBe(1);
    expect(shipSensorRange('frigate')).toBe(SHIP_SENSOR_RANGE.frigate);
    expect(settlementSensorRangeFor('station')).toBe(SETTLEMENT_SENSOR_RANGE.station);
  });

  it('scales every class and settlement type together', () => {
    setSensorScale(4);
    for (const [cls, base] of Object.entries(SHIP_SENSOR_RANGE)) {
      expect(shipSensorRange(cls)).toBe(base * 4);
    }
    for (const [type, base] of Object.entries(SETTLEMENT_SENSOR_RANGE)) {
      expect(settlementSensorRangeFor(type)).toBe(base * 4);
    }
  });

  it('scales the fallbacks too — an unknown class must not stay unscaled', () => {
    // The old code read `SHIP_SENSOR_RANGE[s.class] ?? 25`. A hull class
    // the table does not name would have kept a literal 25 on a map
    // spread four times over.
    setSensorScale(4);
    expect(shipSensorRange('dreadnought-that-does-not-exist')).toBe(100);
    expect(settlementSensorRangeFor('outpost-that-does-not-exist')).toBe(160);
  });

  it('refuses nonsense rather than blanking the map', () => {
    // A bad payload must not zero every sensor — that would black out
    // the whole board, which reads as "everything died".
    for (const bad of [0, -3, NaN, Infinity, undefined as unknown as number]) {
      setSensorScale(bad);
      expect(sensorScale()).toBe(1);
    }
  });

  it('at staging settings a station sees 3,200, not 800', () => {
    // The exact regression, stated in the numbers that made it visible.
    setSensorScale(4);
    expect(settlementSensorRangeFor('station')).toBe(3200);
  });
});
