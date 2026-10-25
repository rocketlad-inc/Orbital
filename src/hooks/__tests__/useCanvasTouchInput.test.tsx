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

// The world menu's state, set per test: mounted (MP) and which world is open.
const mockMenu: { active: boolean; open: string | null } = { active: false, open: null };
jest.mock('../../game/worldMenu/store', () => ({
  getWorldMenuMaxScale: () => 50,
  isWorldMenuActive: () => mockMenu.active,
  getWorldMenuOpenBodyId: () => mockMenu.open,
}));

// React 18 wants to be told this is a test environment for act().
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Cam = { x: number; y: number; scale: number };

interface Setup {
  selectMode?: boolean;
  longPressUsed?: boolean;
  focusedBodyId?: string;
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
      camera: { x: 0, y: 0, scale: 1, ...(opts.focusedBodyId ? { focusedBodyId: opts.focusedBodyId } : {}) } as Cam,
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
    canvas: () => canvas!,
    /** A TouchEvent carrying every finger now down: [target, x, y]. */
    touch: (type: string, target: EventTarget, fingers: Array<[EventTarget, number, number]>) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'touches', {
        value: fingers.map(([tg, x, y]) => ({ target: tg, clientX: x, clientY: y })),
      });
      act(() => { target.dispatchEvent(e); });
    },
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

describe('two fingers and the world menu', () => {
  afterEach(() => { mockMenu.active = false; mockMenu.open = null; });

  function menuChrome() {
    const root = document.createElement('div');
    root.className = 'wm-root';
    const sheet = document.createElement('section');
    root.appendChild(sheet);
    document.body.appendChild(root);
    return { sheet, done: () => root.remove() };
  }

  it('a pinch with a finger on the menu still zooms the map (Maya: "only ever saw Europa")', () => {
    mockMenu.active = true; mockMenu.open = 'europa';
    const t = mount({ focusedBodyId: 'europa' });
    const chrome = menuChrome();
    const cv = t.canvas();
    // One finger on the map, one on the menu's sheet; the canvas only
    // ever sees its own.
    t.down(1, 300, 300);
    t.touch('touchstart', chrome.sheet, [[cv, 300, 300], [chrome.sheet, 500, 300]]);
    // Pinch IN, fingers closing to half their spread: zoom out by 2.
    t.move(1, 350, 300);
    t.touch('touchmove', chrome.sheet, [[cv, 350, 300], [chrome.sheet, 450, 300]]);
    const last = t.updates[t.updates.length - 1];
    expect(last.scale).toBeCloseTo(0.5);
    // The map finger was half a pinch: it neither panned nor tapped.
    t.up(1, 350, 300);
    expect(t.onTap).not.toHaveBeenCalled();
    chrome.done();
    t.unmount();
  });

  it('a pinch on the open menu keeps its world in focus', () => {
    mockMenu.active = true; mockMenu.open = 'europa';
    const t = mount({ focusedBodyId: 'europa' });
    t.down(1, 300, 300);
    t.down(2, 500, 300);
    t.move(2, 600, 300);
    // No write released the focus: the menu fades by zoom, as with the wheel.
    expect(t.updates.some(u => 'focusedBodyId' in u)).toBe(false);
    t.unmount();
  });

  it('stops the moment the menu it was zooming is dismissed', () => {
    mockMenu.active = true; mockMenu.open = 'europa';
    const t = mount({ focusedBodyId: 'europa' });
    t.down(1, 300, 300);
    t.down(2, 500, 300);
    t.move(2, 450, 300);
    const n = t.updates.length;
    mockMenu.open = null;            // zoomed out past the threshold
    t.move(2, 400, 300);
    expect(t.updates.length).toBe(n);
    t.unmount();
  });

  it('a pinch that closes the menu does not leave the map unable to pinch (round 2)', () => {
    // Both fingers on the menu; the pinch closes it and React removes the
    // elements under them. Their touchend then fires on nodes outside the
    // document, so the document never hears it.
    mockMenu.active = true; mockMenu.open = 'earth';
    const t = mount({ focusedBodyId: 'earth' });
    const chrome = menuChrome();
    const a = document.createElement('i'), b = document.createElement('i');
    chrome.sheet.append(a, b);
    t.touch('touchstart', a, [[a, 200, 300], [b, 600, 300]]);
    t.touch('touchmove', a, [[a, 300, 300], [b, 500, 300]]);
    mockMenu.open = null;
    chrome.done();                       // the menu is gone, fingers and all
    t.touch('touchend', a, []);          // detached: never reaches document
    // A fresh pinch on the map zooms.
    const n = t.updates.length;
    t.down(1, 300, 300);
    t.down(2, 500, 300);
    t.move(2, 400, 300);
    expect(t.updates.slice(n).some(u => typeof u.scale === 'number')).toBe(true);
    t.unmount();
  });

  it('with no menu open a pinch frees the camera, as before', () => {
    mockMenu.active = true; mockMenu.open = null;
    const t = mount({ focusedBodyId: 'mars' });
    t.down(1, 300, 300);
    t.down(2, 500, 300);
    expect(t.updates.some(u => 'focusedBodyId' in u)).toBe(true);
    t.unmount();
  });
});
