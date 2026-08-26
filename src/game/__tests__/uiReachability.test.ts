// CAN A PLAYER ACTUALLY DO THE THING?
//
// Every rule in this file guards the same failure: the server grows a
// capability, the client never grows the control, and the feature is
// live and unreachable. It does not fail a build, does not fail a test,
// does not log — the only symptom is that nobody ever uses it.
//
// It has happened at least once for real. construction_pact was a valid
// pact kind on the server, deliberately ungated, read by
// constructionPartners(), enforced by maySupplySite() in three places,
// served by /state, labelled in PACT_LABELS and badged in FactionPanel —
// and absent from ONE array in TradeComposer. Across every live game:
// 43 treaties, none of that kind, because no player could propose one.
// Megastructure co-funding sat behind a pact the UI could not form.
//
// These read SOURCE TEXT rather than importing, because the point is to
// compare two lists that are deliberately written twice — one in a
// worker module the client cannot import, one in a component.

import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/** The contents of a `new Set([...])` or `[...]` literal, as strings. */
function literalMembers(src: string, anchor: string): string[] {
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor}`);
  // From the '=', not the anchor: a typed declaration carries its own
  // brackets — `PactKind[] = [...]` — and grabbing the first '[' after
  // the name reads the type annotation as an empty list. Which is
  // exactly the shape of a parity test that passes by finding nothing.
  const eq = src.indexOf('=', at);
  const open = src.indexOf('[', eq === -1 ? at : eq);
  const close = src.indexOf(']', open);
  if (open === -1 || close === -1) throw new Error(`no list after: ${anchor}`);
  return [...src.slice(open + 1, close).matchAll(/'([^']+)'/g)].map(m => m[1]);
}

describe('pacts', () => {
  it('every pact the server accepts can be proposed in the composer', () => {
    const server = literalMembers(read('worker/trades.js'), 'const PACT_KINDS =');
    const client = literalMembers(
      read('src/multiplayer/TradeComposer.tsx'), 'const PACT_KINDS_ORDER',
    );
    expect([...server].sort()).toEqual([...client].sort());
  });

  it('the composer offers nothing the server would refuse', () => {
    // The other direction of the same wall: a control that posts a kind
    // the endpoint rejects is a button that always errors.
    const server = new Set(literalMembers(read('worker/trades.js'), 'const PACT_KINDS ='));
    for (const k of literalMembers(
      read('src/multiplayer/TradeComposer.tsx'), 'const PACT_KINDS_ORDER',
    )) {
      expect(server.has(k)).toBe(true);
    }
  });

  it('every proposable pact has a label to render', () => {
    const labels = read('src/multiplayer/api.ts');
    for (const k of literalMembers(
      read('src/multiplayer/TradeComposer.tsx'), 'const PACT_KINDS_ORDER',
    )) {
      expect(labels.includes(`${k}: '`)).toBe(true);
    }
  });

  it('the client and server agree on which pacts cost research', () => {
    const server = literalMembers(read('worker/trades.js'), 'const GATED_PACTS =');
    const client = literalMembers(
      read('src/multiplayer/TradeComposer.tsx'), 'const GATED_PACT_KINDS =',
    );
    expect([...server].sort()).toEqual([...client].sort());
  });
});

describe('build orders', () => {
  it('every build-order verb the server accepts is reachable in the world menu', () => {
    const server = literalMembers(read('worker/actions.js'), 'const BUILD_ORDERS =');
    const menu = read('src/multiplayer/WorldMenuOverlay.tsx');
    const missing = server.filter(v => !menu.includes(`'${v}'`));
    expect(missing).toEqual([]);
  });
});

// ── THE STRUCTURAL SWEEPS ───────────────────────────────────────────
// The two above guard lists somebody has to remember to extend. These
// two guard the whole surface, which is what actually caught the second
// dead feature: asset deals shipped with four endpoints, its own worker
// module, a migration, a /state field and tick-side delivery — and no
// client code at all. Zero rows in every live game, because nothing
// could create one.

/** Client source, minus tests: what a player can actually reach. */
function clientSource(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); continue; }
      if (/\.(ts|tsx)$/.test(e.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(root, 'src'));
  return out.join('\n');
}

describe('server surface', () => {
  // Routes with no UI ON PURPOSE: operated by curl or the admin console,
  // never by a player. Anything NOT here is expected to be reachable.
  const HEADLESS = [
    'admin/',              // config editor, devlog, discord probes, analytics
    'admin-add-member',    // host re-seats a lost player by email, by curl
    'agent/session',       // agent harness login
  ];

  // KNOWN DEAD, recorded rather than hidden. These endpoints exist,
  // work, and no player can reach them. Listing one is a decision to
  // leave it that way for now; the fix is to delete the entry once the
  // UI lands, not to widen HEADLESS.
  //
  // asset-deals: sell a hull or a world, paid off by freighter. Four
  // endpoints, its own worker module, migration 0114, a /state field and
  // tick-side delivery — and no client code at all. Zero rows in every
  // live game.
  const KNOWN_DEAD = ['asset-deals'];

  it('every player-facing endpoint is called from somewhere in the client', () => {
    const client = clientSource();
    const orphans: string[] = [];
    for (const f of fs.readdirSync(path.join(root, 'worker'))) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(root, 'worker', f), 'utf8');
      for (const m of src.matchAll(/pattern:\s*(\/\^[^,]+?\/|'[^']+'),/g)) {
        // Strip the regex furniture: escaped slashes, anchors, quotes,
        // and the delimiting slashes themselves.
        const raw = m[1]
          .split('\\/').join('/')
          .split('').filter(c => c !== '^' && c !== '$' && c !== "'").join('');
        if (HEADLESS.some(h => raw.includes(h))) continue;
        if (KNOWN_DEAD.some(k => raw.includes(k))) continue;
        const atoms = raw.split('/').filter(a => a && a !== 'api' && !a.includes('(?<'));
        const tail = atoms[atoms.length - 1];
        if (tail && !client.includes(tail)) orphans.push(`${raw}  (${f})`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('every field /state sends is read by the client', () => {
    // A field the server computes and nobody reads is either a dead
    // feature or a rendering bug waiting to be found by a player. Both
    // have happened: asset_deals was the first, and the build queue's
    // ship_name was sent, ignored, and silently replaced with the class
    // name until it produced a phantom duplicate row.
    const state = fs.readFileSync(path.join(root, 'worker/state.js'), 'utf8').split('\n');
    const open = state.findIndex(l => l.trim() === 'return json({');
    expect(open).toBeGreaterThan(-1);
    const keys = state.slice(open, open + 260)
      .map(l => /^ {4}([a-z_][a-z0-9_]*)\s*[,:]/.exec(l.replace(/\r$/, '')))
      .filter(Boolean).map(m => (m as RegExpExecArray)[1]);
    expect(keys.length).toBeGreaterThan(10);   // the parse still works
    const client = clientSource();
    expect(keys.filter(k => !client.includes(k))).toEqual([]);
  });
});
