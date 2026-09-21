// ============================================================
// The map's touch gestures, driven with real pointer events.
//
// What these pin down is the one rule the whole touch design rests on:
// ONE FINGER DRAG STAYS PAN unless the player has asked for a box -- by
// holding first, or by being in selection mode -- and in selection mode
// two fingers still pan. Every mobile strategy game that got this wrong
// (a command wheel on hold, a box on plain drag) was criticised for the
// same thing: the player tried to move the map and did something else.
// ============================================================

import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useCanvasTouchInput, LONG_PRESS_MS, TouchBoxHandlers } from '../useCanvasTouchInput';

jest.mock('../../game/worldMenu/store', () => ({ getWorldMenuMaxScale: () => 50 }));

// React 18 wants to be told this is a test environment for act().
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Cam = { x: number; y: number; scale: number };

interface Setup {
  selectMode?: boolean;
  longPressUsed?: boolean;
}

function mount(opts: Setup = {}) {
  const updates: Array<Partial<Cam>> = [];
  const onTap = jest.fn();
  const onDoubleTap = jest.fn();
  const onLongPress = jest.fn(() => opts.longPressUsed ?? true);
  const box: TouchBoxHandlers = {
    start: jest.fn(), move: jest.fn(), end: jest.fn(), cancel: jest.fn(),
  };
  let canvas: HTMLCanvasElement | null = null;

  const Harness: React.FC = () => {
    const ref = useRef<HTMLCanvasElement>(null);
    useCanvasTouchInput({
      canvasRef: ref,
      camera: { x: 0, y: 0, scale: 1 },
      updateCamera: (p) => { updates.push(p); },
      onTap, onDoubleTap, onLongPress,
      isSelectMode: () => !!opts.selectMode,
      box,
    });
    return <canvas ref={(el) => {
      (ref as React.MutableRefObject<HTMLCanvasElement | null>).current = el;
      canvas = el;
      if (el) {
        // jsdom has no pointer capture; the hook calls it on every down.
        el.setPointerCapture = jest.fn();
        el.releasePointerCapture = jest.fn();
      }
    }} width={800} height={600} />;
  };

  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(<Harness />);
  });

  /** A touch pointer event at client (x, y). jsdom's canvas sits at 0,0,
   *  so client and canvas-local coordinates are the same here. */
  const fire = (type: string, id: number, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(e, {
      pointerType: { value: 'touch' },
      pointerId: { value: id },
      clientX: { value: x },
      clientY: { value: y },
    });
    act(() => { canvas!.dispatchEvent(e); });
  };

  return {
    updates, onTap, onDoubleTap, onLongPress, box,
    down: (id: number, x: number, y: number) => fire('pointerdown', id, x, y),
    move: (id: number, x: number, y: number) => fire('pointermove', id, x, y),
    up: (id: number, x: number, y: number) => fire('pointerup', id, x, y),
    hold: () => act(() => { jest.advanceTimersByTime(LONG_PRESS_MS + 10); }),
    unmount: () => act(() => { root.unmount(); host.remove(); }),
  };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('one finger', () => {
  it('drags to pan, as it always has', () => {
    const t = mount();
    t.down(1, 100, 100);
    t.move(1, 150, 100);
    t.up(1, 150, 100);
    expect(t.updates[t.updates.length - 1]?.x).toBeCloseTo(-50);
    expect(t.box.start).not.toHaveBeenCalled();
    expect(t.onTap).not.toHaveBeenCalled();
    t.unmount();
  });

  it('taps to select', () => {
    const t = mount();
    t.down(1, 100, 100);
    t.up(1, 101, 100);
    expect(t.onTap).toHaveBeenCalledWith(101, 100);
    t.unmount();
  });

  it('uses the platform long-press timing, not the old 500ms', () => {
    expect(LONG_PRESS_MS).toBe(400);
  });
});

describe('long press', () => {
  it('fires after the hold and is not also a tap', () => {
    const t = mount();
    t.down(1, 100, 100);
    t.hold();
    expect(t.onLongPress).toHaveBeenCalledWith(100, 100);
    t.up(1, 100, 100);
    expect(t.onTap).not.toHaveBeenCalled();
    t.unmount();
  });

  it('does not fire if the finger moved first -- that was a pan', () => {
    const t = mount();
    t.down(1, 100, 100);
    t.move(1, 140, 100);
    t.hold();
    expect(t.onLongPress).not.toHaveBeenCalled();
    t.unmount();
  });

  it('then dragging draws a box from where the finger went down, without panning', () => {
    const t = mount();
    t.down(1, 100, 100);
    t.hold();
    const pansBefore = t.updates.length;
    t.move(1, 160, 130);
    t.move(1, 200, 180);
    t.up(1, 200, 180);
    expect(t.box.start).toHaveBeenCalledWith(100, 100);
    expect(t.box.move).toHaveBeenLastCalledWith(200, 180);
    expect(t.box.end).toHaveBeenCalledWith(200, 180);
    expect(t.updates.length).toBe(pansBefore);
    t.unmount();
  });

  it('that was not used lets the drag pan instead of boxing', () => {
    const t = mount({ longPressUsed: false });
    t.down(1, 100, 100);
    t.hold();
    t.move(1, 160, 100);
    expect(t.box.start).not.toHaveBeenCalled();
    expect(t.updates[t.updates.length - 1]?.x).toBeCloseTo(-60);
    t.unmount();
  });
});

describe('selection mode', () => {
  it('turns one-finger drag into a box and never pans', () => {
    const t = mount({ selectMode: true });
    t.down(1, 100, 100);
    t.move(1, 150, 150);
    t.up(1, 150, 150);
    expect(t.box.start).toHaveBeenCalledWith(100, 100);
    expect(t.box.end).toHaveBeenCalledWith(150, 150);
    expect(t.updates).toHaveLength(0);
    t.unmount();
  });

  it('does not nudge the map while a tap wobbles inside the slop', () => {
    const t = mount({ selectMode: true });
    t.down(1, 100, 100);
    t.move(1, 106, 103);
    t.up(1, 106, 103);
    expect(t.updates).toHaveLength(0);
    expect(t.box.start).not.toHaveBeenCalled();
    expect(t.onTap).toHaveBeenCalled();
    t.unmount();
  });

  it('drops a half-drawn box when a second finger lands, rather than committing it', () => {
    const t = mount({ selectMode: true });
    t.down(1, 100, 100);
    t.move(1, 160, 160);
    t.down(2, 300, 300);
    expect(t.box.cancel).toHaveBeenCalled();
    t.up(1, 160, 160);
    expect(t.box.end).not.toHaveBeenCalled();
    t.unmount();
  });
});

describe('two fingers', () => {
  it('pan as well as zoom -- in selection mode they are the only way to pan', () => {
    const t = mount({ selectMode: true });
    t.down(1, 100, 100);
    t.down(2, 200, 100);
    // Both fingers slide right by 10 without changing their spread: a
    // pure pan. The world point that was under the midpoint stays under
    // it, so the camera moves left by 10 at scale 1.
    t.move(1, 110, 100);
    t.move(2, 210, 100);
    const last = t.updates[t.updates.length - 1];
    expect(last.x).toBeCloseTo(-10);
    expect(last.scale).toBeCloseTo(1);
    expect(t.box.start).not.toHaveBeenCalled();
    t.unmount();
  });

  it('pinch still zooms', () => {
    const t = mount();
    t.down(1, 300, 300);
    t.down(2, 500, 300);
    t.move(1, 200, 300);
    t.move(2, 600, 300);
    expect(t.updates[t.updates.length - 1]?.scale).toBeCloseTo(2);
    t.unmount();
  });
});
