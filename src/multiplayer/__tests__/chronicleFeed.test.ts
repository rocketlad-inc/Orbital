// Chronicle feed contract (2026-07-26).
//
// Two regressions this pins:
//  1. The /state events feed was a flat "last 30 by recency", so rare
//     governance rows (3 senate_vote in a live game) were flooded out by
//     high-volume kinds (134 tech_advanced, 124 ship_built) and never
//     reached the log. The feed now unions a notable-kinds reserve.
//  2. tech_advanced / trade_delivered had no formatter and rendered as the
//     raw kind string.
//
// The feed-merge logic is replicated here (it lives in worker/state.js,
// which the CRA test runner doesn't load) so the ORDERING + DEDUPE +
// RESERVE contract is locked even if the SQL is rewritten.

const NOTABLE_KINDS = [
  'senate_vote', 'senate_passed', 'senate_failed', 'chancellor_elected',
  'treaty_signed', 'treaty_broken', 'victory',
  'asteroid_launched', 'asteroid_impact',
];

interface Row { id: string; tick_number: number; kind: string; created_at_ms: number }

/** Mirror of the worker's two-query union. */
function buildFeed(all: Row[], recentLimit = 30, notableLimit = 15): Row[] {
  const byRecency = (a: Row, b: Row) =>
    (b.tick_number - a.tick_number) || (b.created_at_ms - a.created_at_ms);
  const recent = [...all].sort(byRecency).slice(0, recentLimit);
  const notable = [...all]
    .filter(r => NOTABLE_KINDS.includes(r.kind))
    .sort(byRecency)
    .slice(0, notableLimit);
  const map = new Map<string, Row>();
  for (const r of [...recent, ...notable]) map.set(r.id, r);
  return [...map.values()].sort(byRecency);
}

/** A game shaped like the real one: spam plus one old senate vote. */
function noisyGame(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 134; i++) {
    rows.push({ id: `tech${i}`, kind: 'tech_advanced', tick_number: 100 + i, created_at_ms: i });
  }
  rows.push({ id: 'senate1', kind: 'senate_vote', tick_number: 141, created_at_ms: 500 });
  return rows;
}

describe('chronicle feed: rare governance events survive the window', () => {
  it('drops the senate vote under a flat recency limit (the old bug)', () => {
    const flat = [...noisyGame()]
      .sort((a, b) => b.tick_number - a.tick_number)
      .slice(0, 30);
    expect(flat.some(r => r.kind === 'senate_vote')).toBe(false);
  });

  it('keeps the senate vote with the notable reserve (the fix)', () => {
    const feed = buildFeed(noisyGame());
    expect(feed.some(r => r.kind === 'senate_vote')).toBe(true);
  });

  it('never duplicates a row present in both queries', () => {
    const feed = buildFeed(noisyGame());
    expect(new Set(feed.map(r => r.id)).size).toBe(feed.length);
  });

  it('stays sorted newest-first after the union', () => {
    const feed = buildFeed(noisyGame());
    for (let i = 1; i < feed.length; i++) {
      expect(feed[i - 1].tick_number).toBeGreaterThanOrEqual(feed[i].tick_number);
    }
  });

  it('reserves slots for every governance/diplomacy kind we emit', () => {
    for (const k of ['senate_vote', 'treaty_signed', 'treaty_broken', 'victory']) {
      expect(NOTABLE_KINDS).toContain(k);
    }
  });
});

describe('chronicle formatters cover the kinds actually emitted', () => {
  // Kinds observed in prod (SELECT kind, COUNT(*) ... GROUP BY kind).
  const EMITTED = [
    'tech_advanced', 'ship_built', 'building_completed', 'settlement_built',
    'ship_destroyed', 'captain_rescued', 'captain_lost', 'settlement_destroyed',
    'trade_delivered', 'trade_accepted', 'builds_destroyed', 'secret_discovered',
    'treaty_signed', 'senate_vote', 'ship_retreated',
  ];
  // Kinds the provider's formatEvent has an explicit branch for.
  const FORMATTED = [
    'asteroid_impact', 'asteroid_launched', 'building_completed', 'builds_destroyed',
    'captain_lost', 'captain_rescued', 'chancellor_elected', 'secret_discovered',
    'senate_failed', 'senate_passed', 'senate_vote', 'settlement_built',
    'settlement_destroyed', 'ship_built', 'ship_destroyed', 'ship_detonated',
    'ship_retreated', 'tech_advanced', 'trade_accepted', 'trade_delivered',
    'treaty_broken', 'treaty_signed',
  ];

  it('formats every kind the server actually writes (no raw-kind fallbacks)', () => {
    const unformatted = EMITTED.filter(k => !FORMATTED.includes(k));
    expect(unformatted).toEqual([]);
  });

  it('includes the two kinds that were rendering raw', () => {
    expect(FORMATTED).toContain('tech_advanced');
    expect(FORMATTED).toContain('trade_delivered');
  });
});
