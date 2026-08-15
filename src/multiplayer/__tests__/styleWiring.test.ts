// ============================================================
// STYLE WIRING — does anything actually CONSUME what these components
// set?
//
// Written after shipping the trade-lane party colours three times over:
// the party detection, the gradient string, the markup and the CSS
// custom properties all landed and were deployed, and not one pixel
// changed, because the CSS rules that read those properties were never
// written. It was reported as "you still going to do that colour
// coding?" — the honest answer being that it had been "done" twice
// already and had never rendered.
//
// Nothing in the suite could catch it. The sims prove the server; the
// selector tests prove the logic; neither mounts a component, and even
// a render test with @testing-library (which this project doesn't
// carry) would not fail on a style that simply has no effect.
//
// So this checks the seam directly and statically: every --custom-prop
// a component sets must appear in a stylesheet, and every class the
// components lean on for identity must exist. It is crude, and it would
// have caught all three of those bugs.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Components whose look depends on variables/classes they set inline,
 *  paired with the stylesheets allowed to satisfy them. */
const WIRED: Array<{ tsx: string; css: string[] }> = [
  {
    tsx: 'multiplayer/RouteDiagram.tsx',
    css: ['multiplayer/RouteDiagram.css'],
  },
  {
    tsx: 'multiplayer/SettlementTradeTab.tsx',
    css: ['multiplayer/SettlementTradeTab.css', 'multiplayer/RouteDiagram.css'],
  },
  {
    tsx: 'multiplayer/RouteComposer.tsx',
    css: ['multiplayer/RouteComposer.css'],
  },
];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('every CSS custom property a component sets is consumed by a rule', () => {
  for (const { tsx, css } of WIRED) {
    it(`${tsx} — no orphaned custom properties`, () => {
      const source = read(tsx);
      const sheets = css.map(read).join('\n');
      // Properties SET inline, e.g. ['--lane-paint' as string]: value
      const set = new Set(
        [...source.matchAll(/\['(--[a-z0-9-]+)'\s+as\s+string\]/g)].map(m => m[1]),
      );
      const orphans = [...set].filter(v => !sheets.includes(`var(${v}`));
      expect(orphans).toEqual([]);
    });

    it(`${tsx} — every className it renders has a rule`, () => {
      const source = read(tsx);
      const sheets = css.map(read).join('\n');
      // Static classNames only — template-literal ones carry state
      // suffixes that are checked by the modifier test below.
      const used = new Set(
        [...source.matchAll(/className="([a-z][a-z0-9 -]*)"/g)]
          .flatMap(m => m[1].split(/\s+/))
          .filter(Boolean),
      );
      const missing = [...used].filter(c => !sheets.includes(`.${c}`));
      expect(missing).toEqual([]);
    });
  }
});

describe('the trade-lane party colours are actually painted', () => {
  // The specific regression: these three had markup and variables but
  // no rules, and shipped looking identical to a domestic lane.
  const laneCss = read('multiplayer/SettlementTradeTab.css');
  const diagramCss = read('multiplayer/RouteDiagram.css');

  it('the card wears the lane stripe', () => {
    expect(laneCss).toMatch(/\.stt-lane\b/);
    expect(laneCss).toContain('var(--lane-paint');
  });

  it('the partner label has a style', () => {
    expect(laneCss).toMatch(/\.stt-partner\b/);
  });

  it('the circuit paints its legs and its stop rings', () => {
    expect(diagramCss).toMatch(/\.rd-line\b/);
    expect(diagramCss).toContain('var(--stop-owner');
  });

  it('the stripe cannot cover the stall warning', () => {
    // A stalled lane's border is the urgent signal; identity must not
    // be allowed to replace it.
    expect(laneCss).toMatch(/\.stt-route\.is-stalled\b/);
  });
});
