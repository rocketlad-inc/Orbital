// The Email admin tab renders from /api/admin/email/winback, turning the
// email on asks first, and an edit saves only the override.

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { EmailAdmin } from '../EmailAdmin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const counts = { sent: 10, failed: 1, opened: 6, clicked: 3, joined: 2, playing: 1, unsubscribed: 0 };
const payload = {
  enabled: false,
  overrides: {},
  updated_ms: null,
  updated_by: null,
  fields: [
    { key: 'email.winback.seat.subject', label: 'Subject (a game is filling up)', vars: [], defaults: { en: 'A game of Orbital is filling up', 'pt-BR': 'Um jogo' } },
    { key: 'email.winback.cta', label: 'Button', vars: [], defaults: { en: 'Take a seat', 'pt-BR': 'Pegar um lugar' } },
  ],
  locales: ['en', 'pt-BR'],
  max_chars: 600,
  hero_default: 'https://orbital-empire.com/press/email/winback-hero.jpg',
  email_configured: true,
  metrics: {
    totals: counts,
    byMode: { seat: counts, pool: { ...counts, sent: 0 } },
    daily: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, sent: i, opened: 0, clicked: 0 })),
    recent: [{ name: 'milky', email: 'm@x.com', mode: 'seat', sent_ms: Date.now() - 3600_000, ok: true, error: null,
      opened_ms: Date.now() - 1800_000, open_count: 1, clicked_ms: null, joined_ms: null, playing: false, unsubscribed: false }],
  },
  queue: { waiting: 37, enabled: false, next_run_ms: null, hourly_cap: 20, next: { mode: 'pool', count: 8, room: null } },
};

let puts: unknown[] = [];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  puts = [];
  (globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
    const body = url.endsWith('/preview')
      ? { html: '<p>preview</p>', subject: 'A game of Orbital is filling up', preheader: 'p', room_source: 'sample' }
      : init?.method === 'PUT' ? { ok: true } : payload;
    return { ok: true, status: 200, json: async () => body };
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const button = (label: string) =>
  Array.from(host.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement;

async function mount() {
  await act(async () => { root.render(<EmailAdmin />); });
  await settle();
}

it('shows the switch, the results and the editor', async () => {
  await mount();
  const text = host.textContent ?? '';
  expect(text).toContain('Win-back email');
  expect(text).toContain('Off');
  expect(text).toContain('37 players would be eligible');
  expect(text).toContain('Joined a game');
  expect(text).toContain('60%'); // opened 6 of 10
  expect(text).toContain('milky');
  expect(host.querySelector('textarea[placeholder="Take a seat"]')).not.toBeNull();
});

it('turning it on asks first, and does nothing if you say no', async () => {
  await mount();
  const confirm = jest.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  await act(async () => { button('Turn on').click(); });
  expect(confirm.mock.calls[0][0]).toMatch(/37 players are waiting/);
  expect(puts).toHaveLength(0);
  await act(async () => { button('Turn on').click(); });
  await settle();
  expect(puts).toEqual([{ enabled: true }]);
  confirm.mockRestore();
});

it('an edit marks the draft unsaved and saves only the override', async () => {
  await mount();
  const field = host.querySelector('textarea[placeholder="Take a seat"]') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, 'Launch');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.textContent).toContain('Unsaved changes');
  await act(async () => { button('Save changes').click(); });
  await settle();
  expect(puts).toEqual([{ overrides: { en: { 'email.winback.cta': 'Launch' } } }]);
});
