/**
 * The lobby sky must not throw when the window has no size.
 *
 * 2026-10-06, the desktop app's browser pane (dev build), on the lobby
 * right after sign-in: every animation frame threw "Failed to execute
 * 'drawImage' ... a canvas element with a width or height of 0" at
 * `ctx.drawImage(backdrop, 0, 0)`, and the dev overlay covered the page.
 * The sky sizes itself from window.innerWidth/innerHeight, which are 0
 * while the pane is collapsed or hidden, so the backdrop and the drift
 * layers were built 0 px wide.
 *
 * jsdom has no 2D canvas, so the context here is a fake whose drawImage
 * refuses a 0-sized canvas exactly the way Chrome does.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { LobbyStarfield } from '../LobbyStarfield';

const drawn: Array<{ w: number; h: number }> = [];

function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  return {
    drawImage: (img: HTMLCanvasElement) => {
      if (img.width === 0 || img.height === 0) {
        throw new DOMException(
          "Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.",
          'InvalidStateError',
        );
      }
      drawn.push({ w: img.width, h: img.height });
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    setTransform() {}, scale() {}, translate() {}, rotate() {}, save() {}, restore() {},
    fillRect() {}, beginPath() {}, arc() {}, fill() {},
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;
}

let rafQueue: FrameRequestCallback[] = [];
let clock = 1000;
/** Run one animation frame, 40 ms after the last (past the ~30 fps gate). */
function frame() {
  clock += 40;
  const due = rafQueue;
  rafQueue = [];
  for (const cb of due) cb(clock);
}

function setWindow(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

let host: HTMLDivElement;
let root: Root;
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
const realW = window.innerWidth;
const realH = window.innerHeight;

beforeEach(() => {
  jest.useFakeTimers();
  drawn.length = 0;
  rafQueue = [];
  HTMLCanvasElement.prototype.getContext = function () { return fakeContext(); } as never;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; };
  window.cancelAnimationFrame = () => { rafQueue = []; };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  HTMLCanvasElement.prototype.getContext = realGetContext;
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
  setWindow(realW, realH);
  jest.useRealTimers();
});

function mount() {
  act(() => root.render(<LobbyStarfield />));
}

test('a 0x0 window draws nothing and does not throw', () => {
  setWindow(0, 0);
  mount();
  expect(() => { for (let i = 0; i < 5; i++) frame(); }).not.toThrow();
  expect(drawn).toEqual([]);
});

test('a window with width but no height does not throw either', () => {
  setWindow(765, 0);
  mount();
  expect(() => { for (let i = 0; i < 3; i++) frame(); }).not.toThrow();
  expect(drawn).toEqual([]);
});

test('the sky paints once the window gets a real size, via resize', () => {
  setWindow(0, 0);
  mount();
  frame();
  setWindow(765, 900);
  act(() => {
    window.dispatchEvent(new Event('resize'));
    jest.advanceTimersByTime(200);
  });
  frame();
  // Backdrop plus three drift layers (each twice the screen wide).
  expect(drawn[0]).toEqual({ w: 765, h: 900 });
  expect(drawn.slice(1)).toEqual([
    { w: 1530, h: 900 }, { w: 1530, h: 900 }, { w: 1530, h: 900 },
  ]);
});

test('the sky paints once the window gets a real size, even with no resize event', () => {
  setWindow(0, 0);
  mount();
  frame();
  setWindow(765, 900);
  frame();
  expect(drawn[0]).toEqual({ w: 765, h: 900 });
});

test('shrinking a painted sky to nothing stops drawing instead of throwing', () => {
  setWindow(765, 900);
  mount();
  frame();
  expect(drawn.length).toBe(4);
  setWindow(0, 0);
  act(() => {
    window.dispatchEvent(new Event('resize'));
    jest.advanceTimersByTime(200);
  });
  drawn.length = 0;
  expect(() => { for (let i = 0; i < 3; i++) frame(); }).not.toThrow();
  expect(drawn).toEqual([]);
});
