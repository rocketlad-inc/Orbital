// ============================================================
// A REFUSED ROOM IS NOT A NETWORK BLIP.
//
// From a screenshot of the console: six red
// "WebSocket connection to wss://…/api/rooms/N8iIYOKw_4q1/ws failed",
// from three different files, against a room whose only members were
// three agent test accounts. The Worker answered 403 every time. All
// three reconnect loops read that as hotel wifi: the lobby's retried
// flat every 1.5s (forty a minute), the provider's backed off to 30s
// and knocked forever, and nothing ever told the player why.
//
// The browser refuses to expose the HTTP status of a failed upgrade, so
// the only way to know is to ask the REST endpoint — which is what
// these tests pin down.
// ============================================================

import { connectRoomSocket } from '../roomSocket';

class FakeSocket {
  static made: FakeSocket[] = [];
  listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  readyState = 0;
  constructor(public url: string) { FakeSocket.made.push(this); }
  addEventListener(kind: string, fn: (ev?: unknown) => void) {
    (this.listeners[kind] ??= []).push(fn);
  }
  fire(kind: string, ev?: unknown) { (this.listeners[kind] ?? []).forEach(f => f(ev)); }
  close() { /* the helper calls this on teardown */ }
  /** An upgrade the server refused: no 'open', straight to 'close'. */
  refuse() { this.fire('error'); this.fire('close'); }
  accept() { this.readyState = 1; this.fire('open'); }
}

/** Runs every timer the helper schedules, in order, until quiet. */
function makeClock() {
  let queue: Array<{ id: number; fn: () => void }> = [];
  let next = 1;
  return {
    setTimeoutFn: ((fn: () => void) => {
      const id = next++;
      queue.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => { queue = queue.filter(t => t.id !== id); }) as unknown as typeof clearTimeout,
    async run(times = 10) {
      for (let i = 0; i < times; i++) {
        const due = queue;
        queue = [];
        due.forEach(t => t.fn());
        await Promise.resolve();       // let the probe's .then settle
        await Promise.resolve();
      }
    },
    pending: () => queue.length,
  };
}

beforeEach(() => { FakeSocket.made = []; });

const start = (probeStatus: number) => {
  const clock = makeClock();
  const probe = jest.fn(async () => ({ status: probeStatus }));
  const onGiveUp = jest.fn();
  const handle = connectRoomSocket('N8iIYOKw_4q1', { onGiveUp }, {
    makeSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    probe,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { clock, probe, onGiveUp, handle };
};

describe('room socket reconnect policy', () => {
  it('stops for good when the room says 403 — and says so once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { clock, onGiveUp } = start(403);

    // Refuse everything the helper opens, many times over.
    for (let i = 0; i < 12; i++) {
      FakeSocket.made.forEach(s => s.refuse());
      await clock.run(1);
    }

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith('forbidden');
    // The whole point: a bounded number of attempts, not forty a minute
    // forever. Two failures trigger the probe, and the probe ends it.
    expect(FakeSocket.made.length).toBe(2);
    expect(clock.pending()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps reconnecting when the failure is a blip, not a refusal', async () => {
    const { clock, probe } = start(200);
    for (let i = 0; i < 6; i++) {
      FakeSocket.made.forEach(s => s.refuse());
      await clock.run(1);
    }
    // Asked, was told the room is fine, kept trying.
    expect(probe).toHaveBeenCalled();
    expect(FakeSocket.made.length).toBeGreaterThan(2);
  });

  it('a socket that opens resets the count, so a later blip still retries', async () => {
    const { clock, onGiveUp } = start(403);
    FakeSocket.made[0].refuse();          // one bad attempt
    await clock.run(1);
    FakeSocket.made[FakeSocket.made.length - 1].accept();   // then a good one
    await clock.run(1);
    FakeSocket.made[FakeSocket.made.length - 1].fire('close');
    await clock.run(1);
    // One failure since the open: below the probe threshold, so it is
    // still reconnecting rather than giving up on a room it just used.
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('close() stops everything, with nothing left scheduled', async () => {
    const { clock, handle, onGiveUp } = start(403);
    FakeSocket.made[0].refuse();
    handle.close();
    await clock.run(3);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(FakeSocket.made.length).toBe(1);
  });
});
