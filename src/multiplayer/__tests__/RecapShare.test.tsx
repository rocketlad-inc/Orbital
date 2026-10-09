// The recap page's share bar and its door into the game.

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { RecapShareBar, RecapJoinCta, recapUrl } from '../RecapShare';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('shares the bare recap link, whose unfurl is the battle card', () => {
  expect(recapUrl('abc_DEF-123')).toBe('https://orbital-empire.com/recap/abc_DEF-123');
});

it('copies the link and says so', async () => {
  const writeText = jest.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await act(async () => { root.render(<RecapShareBar token="tok12345678" text="The Battle of Mars" />); });
  const copy = Array.from(host.querySelectorAll('button')).find(b => /copy/i.test(b.textContent ?? ''))!;
  await act(async () => { copy.click(); });
  expect(writeText).toHaveBeenCalledWith('https://orbital-empire.com/recap/tok12345678');
  expect(host.textContent).toMatch(/copied/i);
});

it('offers Reddit and X with the link and the text', async () => {
  await act(async () => { root.render(<RecapShareBar token="tok12345678" text="The Battle of Mars" />); });
  const links = Array.from(host.querySelectorAll('a')).map(a => a.getAttribute('href') ?? '');
  expect(links.some(h => h.startsWith('https://www.reddit.com/submit?url=https%3A%2F%2Forbital-empire.com%2Frecap%2Ftok12345678&title=The%20Battle%20of%20Mars'))).toBe(true);
  expect(links.some(h => h.startsWith('https://x.com/intent/post?url=https%3A%2F%2Forbital-empire.com%2Frecap%2Ftok12345678'))).toBe(true);
});

it('the play button is tagged so recap signups can be counted', async () => {
  await act(async () => { root.render(<RecapJoinCta />); });
  const a = host.querySelector('a.recap-cta__btn') as HTMLAnchorElement;
  expect(a.getAttribute('href')).toBe('/?from=recap');
});
