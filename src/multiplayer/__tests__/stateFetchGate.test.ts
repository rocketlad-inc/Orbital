// R2-C11: /state ran back to back (3-8 a second on staging) because the
// "asked again while in flight" re-run fired the instant each response
// landed. The gate caps how close two starts can be, for every caller.
import { makeFetchGate } from '../stateFetchGate';

function harness(rttMs: number, minGapMs: number) {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const starts: number[] = [];
  const run = () => new Promise<void>(resolve => {
    starts.push(clock);
    timers.push({ at: clock + rttMs, fn: resolve });
  });
  const gate = makeFetchGate(run, minGapMs, {
    now: () => clock,
    setTimeoutFn: (fn, ms) => { timers.push({ at: clock + ms, fn }); },
  });
  const advance = async (to: number) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > to) break;
      timers.shift();
      clock = next.at;
      next.fn();
      // let promise continuations (finally -> re-run) settle
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    clock = to;
  };
  return { gate, advance, starts };
}

test('a caller asking every 100 ms gets at most one start per gap', async () => {
  const h = harness(150, 700);
  for (let t = 0; t < 10_000; t += 100) {
    void h.gate();
    // eslint-disable-next-line no-await-in-loop
    await h.advance(t + 100);
  }
  // Without the floor this is one start per round trip: ~66 in 10 s.
  expect(h.starts.length).toBeLessThanOrEqual(15);
  for (let i = 1; i < h.starts.length; i++) expect(h.starts[i] - h.starts[i - 1]).toBeGreaterThanOrEqual(700);
});

test('an ask made while one is in flight still gets one fresh fetch after it', async () => {
  const h = harness(300, 700);
  void h.gate();          // starts at 0
  await h.advance(100);
  void h.gate();          // in flight: folds into one trailing fetch
  void h.gate();
  await h.advance(2000);
  expect(h.starts).toEqual([0, 700]);
});

test('a lone ask after a quiet spell starts at once', async () => {
  const h = harness(100, 700);
  void h.gate();
  await h.advance(5000);
  void h.gate();
  expect(h.starts).toEqual([0, 5000]);
});
