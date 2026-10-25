/**
 * Games the idle cull ended (worker/cull.js) and lobbies it closed.
 *
 *   * the ending page of an abandoned game: GAME OVER (never VICTORY), the
 *     "ended after 15 days without activity" verdict instead of a winner,
 *     the standings still shown, NO superlatives and NO Commission plug, and
 *     a timeline whose last moment names nobody
 *   * My Games cards: a quiet "Ended: inactive" fact instead of a winner; a
 *     closed lobby reads "Closed: idle" with nothing to press
 *   * the event log line for the game_abandoned chronicle row, in both languages
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import type { EndingPayload } from '../endingTypes';

jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: { is_premium: false } }) }));
jest.mock('../api', () => ({
  apiFetch: jest.fn(),
  startCommissionCheckout: jest.fn(async () => null),
}));
jest.mock('../commission', () => ({
  ...jest.requireActual('../commission'),
  canBuyHere: () => true,
  openCommissionInBrowser: jest.fn(),
  logCommission: jest.fn(),
}));
jest.mock('../MatchReplay', () => ({ MatchReplay: () => null }));

// eslint-disable-next-line import/first
import { apiFetch } from '../api';
// eslint-disable-next-line import/first
import { logCommission } from '../commission';
// eslint-disable-next-line import/first
import { EndingScreen } from '../EndingScreen';
// eslint-disable-next-line import/first
import { EndingMeta } from '../EndingPage';
// eslint-disable-next-line import/first
import { buildTimeline, withViewer } from '../endingModel';
// eslint-disable-next-line import/first
import { GameCard, GameSummary } from '../LobbyCards';
// eslint-disable-next-line import/first
import { formatChronicleEvent } from '../eventText';
// eslint-disable-next-line import/first
import { setLang } from '../../i18n/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEGA: EndingPayload = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '__fixtures__', 'ending.ghhqbPbWz64Y.json'), 'utf8'));

/** The same real game, as the cull leaves it: no winner, no superlatives
 *  (the server sends none), and the last timeline moment names nobody. */
function abandoned(keepAwards = false): EndingPayload {
  const d: EndingPayload = JSON.parse(JSON.stringify(MEGA));
  d.game.victoryType = 'abandoned';
  d.game.winnerFactionId = null;
  d.game.victoryDetail = null;
  d.factions = d.factions.map(f => ({ ...f, isWinner: false }));
  if (!keepAwards) d.awards = [];
  d.timeline = d.timeline.map(m => (m.kind === 'victory'
    ? { ...m, factionIds: [], detail: 'abandoned' }
    : m));
  return d;
}

function metaFor(d: EndingPayload): EndingMeta {
  const me = d.factions.find(f => f.isMe);
  return {
    winnerFactionId: null,
    winnerName: null,
    victoryType: 'abandoned',
    myFactionId: me?.id ?? null,
    factions: d.factions.map(f => ({ id: f.id, name: f.name, color: f.color, color2: f.color2, emblem: f.emblem, status: f.finalStatus })),
  };
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';

async function mount(meta: EndingMeta, answer: () => Promise<unknown>) {
  (apiFetch as jest.Mock).mockImplementation(async (p: string) => (p.includes('/ending') ? answer() : { ok: true, status: 200, data: {} }));
  await act(async () => { root.render(<EndingScreen gameId="g1" meta={meta} onReturn={jest.fn()} />); });
  await act(async () => { await Promise.resolve(); });
  for (let i = 0; i < 60 && !/Return to lobby/.test(text()); i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });
  }
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* fine */ }
  setLang('en', false);
  (logCommission as jest.Mock).mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the ending page of a game ended for inactivity', () => {
  it('says GAME OVER and why, with no winner, no superlatives and no sales pitch', async () => {
    // The viewer's empire survived to the end: exactly who is shown the Commission after a real win.
    const d = withViewer(abandoned(), 'Tritalowda');
    expect(d.factions.find(f => f.isMe)?.finalStatus).toBe('active');
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    expect(host.querySelector('h1')?.textContent).toBe('GAME OVER');
    expect(text()).not.toContain('VICTORY');
    expect(text()).toContain('The game ended after 15 days without activity.');
    expect(text()).not.toContain('wins');
    expect(host.querySelector('.ep-winner__name')).toBeNull();
    expect(text()).toContain('Final standings');
    expect(text()).toContain('Your empire');
    expect(text()).not.toContain('Superlatives');
    expect(host.querySelectorAll('.ep-aw')).toHaveLength(0);
    expect(text()).not.toContain('Same empire, new lines.');
    expect(logCommission).not.toHaveBeenCalled();
    expect(localStorage.getItem('orbital.commission.endgame.g1')).toBeNull();
    expect(host.querySelector('.ep-tag--win')).toBeNull();
  });

  it('shows no superlatives even if a payload still carried some', async () => {
    const d = withViewer(abandoned(true), 'Tritalowda');
    expect(d.awards.length).toBeGreaterThan(0);
    await mount(metaFor(d), async () => ({ ok: true, status: 200, data: d }));
    expect(text()).not.toContain('Superlatives');
    expect(host.querySelectorAll('.ep-aw')).toHaveLength(0);
  });

  it('while the report loads, and if it fails, the verdict is still the honest one and nothing is sold', async () => {
    const d = withViewer(abandoned(), 'Tritalowda');
    await mount(metaFor(d), async () => ({ ok: false, status: 500, error: { code: 'x' } }));
    expect(host.querySelector('h1')?.textContent).toBe('GAME OVER');
    expect(text()).toContain('The game ended after 15 days without activity.');
    expect(text()).not.toContain('Same empire, new lines.');
    expect(logCommission).not.toHaveBeenCalled();
  });

  it('reads in Portuguese', async () => {
    const d = withViewer(abandoned(), 'none');
    setLang('pt-BR', false);
    await act(async () => { root.render(<div />); });
    (apiFetch as jest.Mock).mockImplementation(async () => ({ ok: true, status: 200, data: d }));
    await act(async () => { root.render(<EndingScreen gameId="g1" meta={metaFor(d)} onReturn={jest.fn()} />); });
    for (let i = 0; i < 60 && !/Voltar|lobby|sala/i.test(text()); i++) {
      await act(async () => { await new Promise(r => setTimeout(r, 15)); });
    }
    expect(text()).toContain('O jogo foi encerrado após 15 dias sem atividade.');
    expect(host.querySelector('h1')?.textContent).toBe('FIM DE JOGO');
  });

  it('the timeline ends without a winner and does not crash on one that is null', () => {
    const d = withViewer(abandoned(), 'none');
    const rows = buildTimeline(d);
    const last = rows[rows.length - 1];
    expect(last.kind).toBe('victory');
    expect(last.title.key).toBe('ending.tl.victory.noWinner');
    expect(last.sub?.key).toBe('ending.verdict.abandoned');
  });
});

describe('My Games cards', () => {
  const base: GameSummary = {
    id: 'g1', name: 'Quiet Game', phase: 'finished', max_players: 4, member_count: 2, open_seats: 2,
    has_password: false, quick_join: false, host_id: 'u1', host_name: 'Ada',
    created_at: 1, updated_at: 1_000_000, started_at: 1, completed_at: 1_000_000, current_tick: 812,
    next_tick_at: null, tick_interval_ms: 3_600_000, is_member: true, joinable: false,
    players: [{ name: 'Ada', is_host: true, is_you: true }, { name: 'Bo' }], leader: null, winner: null, me: null,
  };
  const card = (g: GameSummary) => {
    act(() => { root.render(<GameCard g={g} now={2_000_000} variant="mine" onPrimary={jest.fn()} myUserId="u1" />); });
    return host;
  };

  it('a game the cull ended: a quiet "Ended: inactive", no winner line, still viewable', () => {
    card({ ...base, abandoned: true });
    expect(text()).toContain('Ended: inactive');
    expect(text()).toContain('Ended after 15 days without activity');
    expect(text()).not.toContain('Winner');
    expect(text()).not.toContain('Finished');
    expect(host.querySelector('button')?.textContent).toBe('View');
  });

  it('a lobby the cull closed: "Closed: idle", nothing to press', () => {
    card({ ...base, closed: 'idle', current_tick: null, completed_at: null, started_at: null, tick_interval_ms: null });
    expect(text()).toContain('Closed: idle');
    expect(text()).toContain('Closed after 15 days without activity');
    expect(host.querySelector('button.lx-btn')).toBeNull();
    expect(host.querySelector('.lx-card__none')?.textContent).toBe('Closed');
  });

  it('a game that was won still shows its winner', () => {
    card({ ...base, winner: { name: 'Zed Corp', color: '#fff', emblem: null, victory_type: 'domination' } });
    expect(text()).toContain('Winner');
    expect(text()).toContain('Zed Corp');
    expect(text()).not.toContain('Ended: inactive');
  });

  it('both read in Portuguese', () => {
    setLang('pt-BR', false);
    card({ ...base, abandoned: true });
    expect(text()).toContain('Encerrado: inativo');
    expect(text()).toContain('Encerrado após 15 dias sem atividade');
    card({ ...base, closed: 'idle', current_tick: null, completed_at: null });
    expect(text()).toContain('Fechada: inativa');
  });
});

describe('the event log', () => {
  const ctx = { factionNameById: new Map<string, string>() };
  it('says the game ended for inactivity, in both languages', () => {
    const row = { tick_number: 812, kind: 'game_abandoned', actor_faction_id: null, target_faction_id: null,
      payload: '{"reason":"idle","days":15}' };
    expect(formatChronicleEvent(row, ctx, 'en')).toBe('T+812  ⏹ GAME OVER — ended after 15 days without activity');
    expect(formatChronicleEvent(row, ctx, 'pt-BR')).toBe('T+812  ⏹ FIM DE JOGO — encerrado após 15 dias sem atividade');
  });
});
