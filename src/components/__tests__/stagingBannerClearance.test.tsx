/**
 * THE TOP BAR SITS CLEAR OF THE STAGING BANNER (playtest C18), AND
 * PRODUCTION IS UNCHANGED.
 *
 * Maya, phone, staging (2026-10-24): the resource pills sat under the
 * hazard stripes. The banner publishes its height as --stg-h; the bar's
 * height and every "below the bar" anchor read it through --topbar-h,
 * with a 0px fallback, so a page without the banner lays out exactly as
 * before.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { StagingBanner } from '../StagingBanner';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

async function mountWith(env: string) {
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    json: async () => ({ env, git_sha: 'abc1234def' }),
  }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<StagingBanner />); });
  await act(async () => { await Promise.resolve(); });
  return { done: () => { act(() => root.unmount()); host.remove(); } };
}

describe('staging banner clearance', () => {
  afterEach(() => { document.documentElement.style.removeProperty('--stg-h'); });

  it('the bar height and its padding fall back to the production numbers', () => {
    expect(read('App.css')).toMatch(/--topbar-h:\s*calc\(48px \+ var\(--stg-h, 0px\)\)/);
    expect(read('components/TopBar.css')).toMatch(/padding-top:\s*var\(--stg-h, 0px\)/);
  });

  it('staging publishes the banner height; leaving takes it away', async () => {
    const m = await mountWith('staging');
    expect(document.querySelector('.stg-banner')).not.toBeNull();
    // jsdom has no layout, so the measured height is 0px -- but it is SET.
    expect(document.documentElement.style.getPropertyValue('--stg-h')).toMatch(/^\d+px$/);
    m.done();
    expect(document.documentElement.style.getPropertyValue('--stg-h')).toBe('');
  });

  it('production sets nothing', async () => {
    const m = await mountWith('production');
    expect(document.querySelector('.stg-banner')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--stg-h')).toBe('');
    m.done();
  });
});
