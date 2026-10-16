/**
 * A typed number must not fight the typist (review, 2026-10-15): typing
 * 1200 into Orbit used to clamp each keystroke (1 -> 60, 12 -> 60,
 * 120 -> 120...) and push an undo step per key. NumberField edits as text
 * and commits once, clamped, on blur or Enter; Escape or junk reverts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NumberField } from '../Inspector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
function type(input: HTMLInputElement, text: string) {
  for (let i = 1; i <= text.length; i++) {
    act(() => {
      setter.call(input, text.slice(0, i));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}
const key = (input: HTMLInputElement, k: string) => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

function mount(value: number, onCommit: (v: number) => void) {
  act(() => root.render(<NumberField value={value} min={60} max={14000} step={1} label="Orbit" onCommit={onCommit} />));
  return host.querySelector('input')!;
}

it('commits once, on blur, the number typed', () => {
  const got: number[] = [];
  const input = mount(300, v => got.push(v));
  act(() => input.focus());
  type(input, '1200');
  expect(input.value).toBe('1200');
  expect(got).toEqual([]);
  act(() => input.blur());
  expect(got).toEqual([1200]);
});

it('Enter commits; the value is clamped only then', () => {
  const got: number[] = [];
  const input = mount(300, v => got.push(v));
  type(input, '20');
  expect(input.value).toBe('20');
  key(input, 'Enter');
  expect(got).toEqual([60]);
});

it('Escape and junk put the last good value back without a commit', () => {
  const got: number[] = [];
  const input = mount(300, v => got.push(v));
  type(input, '999');
  key(input, 'Escape');
  expect(input.value).toBe('300');
  type(input, 'abc');
  act(() => { input.focus(); input.blur(); });
  expect(input.value).toBe('300');
  expect(got).toEqual([]);
});

it('an unchanged value commits nothing (no empty undo step)', () => {
  const got: number[] = [];
  const input = mount(300, v => got.push(v));
  type(input, '300');
  key(input, 'Enter');
  expect(got).toEqual([]);
});
