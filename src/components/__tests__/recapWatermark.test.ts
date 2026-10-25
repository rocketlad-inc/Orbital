// R2-C12: the WATCH RECAP banner came back after a 5 s reload. The
// watermark was a COUNT, so a load whose first log was shorter stored a
// smaller count and the next load read old history as new.
import { recapWatermark } from '../RecapOverlay';

const L = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `T+${from + i}  event ${from + i}`);

test('first visit: everything is new', () => {
  expect(recapWatermark(L(10), null).start).toBe(0);
});
test('a reload with nothing new offers nothing', () => {
  const log = L(40);
  const { next } = recapWatermark(log, null);
  expect(recapWatermark(log, next).start).toBe(log.length);
});
test('a short first log never moves the mark back, so the next load is not a re-run', () => {
  const full = L(40);
  const mark = recapWatermark(full, null).next;
  const partial = full.slice(0, 5);          // an early, partial log
  const r = recapWatermark(partial, mark);
  expect(r.start).toBe(partial.length);      // nothing new
  expect(r.next).toBeNull();                 // and the mark is kept
  expect(recapWatermark(full, mark).start).toBe(full.length);
});
test('a rolling window that dropped old rows still finds where you left off', () => {
  const mark = recapWatermark(L(40), null).next;
  const rolled = L(40, 11);                   // rows 11..50: ten new at the end
  expect(recapWatermark(rolled, mark).start).toBe(30);
});
test('an old bare count is still read', () => {
  expect(recapWatermark(L(10), '7').start).toBe(7);
});
