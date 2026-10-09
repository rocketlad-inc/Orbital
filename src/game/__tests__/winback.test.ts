// THE WIN-BACK EMAIL (worker/winback.js): who gets mailed this hour, and
// what each version says.
//
// The rules that matter: never more mail than the open seats can absorb,
// pool the waiting into one fresh game when nothing is open, and hold
// rather than send three people to wait alone. And every line has to
// render in both languages with no stray {placeholder}.

import {
  planWinback, composeWinback,
  WINBACK_HOURLY_CAP, WINBACK_PER_SEAT, POOL_MIN, POOL_SIZE, WINBACK_URL,
} from '../../../worker/winback.js';

const people = (k: number) => Array.from({ length: k }, (_, i) => ({ id: `u${i}` }));
const lobby = (n: number, max: number, extra: object = {}) =>
  ({ id: `r${n}-${max}`, name: 'Open game · Titan', n, max_players: max, quick_join: 1, ...extra });

describe('planWinback', () => {
  it('sends nothing when nobody is waiting', () => {
    expect(planWinback({ eligible: [], lobbies: [lobby(3, 5)] }))
      .toEqual({ mode: 'hold', recipients: [], room: null });
  });

  it('mails two people per open seat, best lobby named', () => {
    const best = lobby(3, 5);
    const plan = planWinback({ eligible: people(30), lobbies: [best, lobby(1, 8)] });
    expect(plan.mode).toBe('seat');
    expect(plan.room).toBe(best);
    // 2 + 7 open seats -> 18 sends
    expect(plan.recipients).toHaveLength((2 + 7) * WINBACK_PER_SEAT);
  });

  it('never exceeds the hourly cap, however many seats are open', () => {
    const plan = planWinback({ eligible: people(100), lobbies: [lobby(1, 10), lobby(1, 10), lobby(1, 10)] });
    expect(plan.recipients).toHaveLength(WINBACK_HOURLY_CAP);
  });

  it('keeps newest signups first', () => {
    const plan = planWinback({ eligible: people(10), lobbies: [lobby(4, 5)] });
    expect(plan.recipients.map(u => u.id)).toEqual(['u0', 'u1']);
  });

  it('ignores a lobby that is already full', () => {
    const plan = planWinback({ eligible: people(2), lobbies: [lobby(5, 5)] });
    expect(plan.mode).toBe('hold');
  });

  it('pools the waiting into one fresh game when nothing is open', () => {
    const plan = planWinback({ eligible: people(50), lobbies: [] });
    expect(plan.mode).toBe('pool');
    expect(plan.room).toBeNull();
    expect(plan.recipients).toHaveLength(POOL_SIZE);
  });

  it('holds when too few are waiting to fill a game together', () => {
    const plan = planWinback({ eligible: people(POOL_MIN - 1), lobbies: [] });
    expect(plan.mode).toBe('hold');
    expect(plan.recipients).toHaveLength(0);
  });
});

describe('composeWinback', () => {
  const cases: Array<[string, 'seat' | 'pool', object | null]> = [
    ['seat, self-starting', 'seat', lobby(3, 5)],
    ['seat, host starts', 'seat', lobby(6, 10, { quick_join: 0 })],
    ['pool', 'pool', null],
  ];
  for (const locale of ['en', 'pt-BR']) {
    for (const [label, mode, room] of cases) {
      it(`${locale}: ${label} renders every line`, () => {
        const c = composeWinback(locale, mode, room);
        const all = [c.subject, c.preheader, c.heading, ...c.lines, c.cta.label, c.footer];
        for (const s of all) {
          expect(typeof s).toBe('string');
          expect(s.length).toBeGreaterThan(0);
          expect(s).not.toMatch(/[{}]|undefined|email\.winback/);
        }
        expect(c.cta.url).toBe(WINBACK_URL);
      });
    }
  }

  it('names the game and its head count when there is a seat', () => {
    const c = composeWinback('en', 'seat', lobby(3, 5));
    expect(c.lines[0]).toContain('Open game · Titan has 3 of 5 commanders');
    expect(c.lines[1]).toMatch(/starts on its own/);
  });

  it('says the host starts a regular lobby, not that it starts itself', () => {
    const c = composeWinback('en', 'seat', lobby(6, 10, { quick_join: 0 }));
    expect(c.lines[1]).toMatch(/host starts it/);
  });
});
