// Thin fetch wrapper for the Worker API. All endpoints are same-origin in
// production; in dev the CRA proxy (src/setupProxy.js) forwards /api/* to
// wrangler dev.

import { logger } from '../game/logger';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code: string; message: string } | null };

/** GETs to these endpoints are high-frequency polls — log only failures
 *  to keep the diagnostic log readable. Writes/non-200s are always logged. */
const SILENT_GET_PREFIXES = [
  '/api/lobby/rooms/',  // /state polling
  '/api/users/me/rooms', // my-rooms refresh
];

/** Same idea for the in-game poll loop, but these carry a variable :gameId
 *  segment so a literal prefix won't match. Silencing the successful 200s
 *  keeps the exported log a readable audit of game events + player actions
 *  instead of a wall of 1-per-second /state heartbeats (errors/non-200s on
 *  these endpoints are still logged by the failure path below). */
const SILENT_GET_PATTERNS: RegExp[] = [
  /\/api\/games\/[^/]+\/state$/,
  /\/api\/games\/[^/]+\/turn\/status$/,
  /\/api\/games\/[^/]+\/me$/,
  /\/api\/games\/[^/]+\/factions$/,
  /\/api\/games\/[^/]+\/pacts$/,
  /\/api\/games\/[^/]+\/trades(\?|$)/,
  /\/api\/games\/[^/]+\/messages\/unread-count$/,
];

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  } catch (e) {
    logger.error('API', `${method} ${path} — network error`, {
      ms: Math.round(performance.now() - t0),
    });
    return { ok: false, status: 0, error: { code: 'network_error', message: 'Network error' } };
  }
  // The dev server falls back to index.html for unknown routes, which would
  // come back as `200 text/html`. Reject anything that isn't JSON so the
  // worker-less dev mode reads as "unauthenticated" instead of crashing.
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    logger.warn('API', `${method} ${path} — non-JSON response`, {
      status: res.status, ms: Math.round(performance.now() - t0),
    });
    return { ok: false, status: res.status, error: { code: 'no_backend', message: 'Multiplayer backend not running' } };
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  const ms = Math.round(performance.now() - t0);
  if (res.ok) {
    // Silence chatty successful polls; log everything else.
    const silent = method === 'GET' && (
      SILENT_GET_PREFIXES.some(p => path.startsWith(p))
      || SILENT_GET_PATTERNS.some(re => re.test(path))
    );
    if (!silent) logger.info('API', `${method} ${path} ${res.status}`, { ms });
    return { ok: true, status: res.status, data: data as T };
  }
  const errCode = data?.error?.code ?? 'unknown';
  const errMsg = data?.error?.message ?? '';
  const level = res.status >= 500 ? 'error' : 'warn';
  logger[level]('API', `${method} ${path} ${res.status} ${errCode}`, {
    ms, error: errMsg || undefined,
  });
  return { ok: false, status: res.status, error: data?.error ?? null };
}

export type User = {
  id: string;
  email: string;
  display_name: string;
};

export type RoomSummary = {
  id: string;
  name: string;
  host_id: string;
  host_name: string;
  status: string;
  max_players: number;
  member_count: number;
  invite_code?: string | null;
  has_password?: boolean;
  tick_interval_ms?: number;
  game_id?: string | null;
  game_status?: string | null;
};

export type RoomMember = {
  userId: string;
  displayName: string;
  empire_name?: string | null;
  bio?: string | null;
  chosen_starting_body?: string | null;
};

export type StartingBodyOption = {
  id: string;
  name: string;
  type: 'terrestrial' | 'moon';
  parent: string | null;
  yield: { metal: number; fuel: number; gold: number; science: number };
};

export type RoomSettings = {
  id: string;
  name: string;
  host_id: string;
  status: string;
  max_players: number;
  invite_code?: string | null;
  has_password?: boolean;
  tick_interval_ms: number;
  game_id: string | null;
  game_status: string | null;
  current_tick: number | null;
};

export type RoomSnapshot = {
  settings: RoomSettings;
  members: RoomMember[];
  connected: string[];
  ready: Record<string, boolean>;
  game_started: boolean;
  game_id: string | null;
  starting_body_options?: StartingBodyOption[];
};

export type Faction = {
  id: string;
  user_id: string | null;
  slot: number;
  name: string;
  color: string;
  status: string;
  capital_body_id: string | null;
  senate_weight: number;
  reputation: number;
};

export type MyFaction = Faction & {
  metal: number;
  fuel: number;
  gold: number;
  science: number;
  research_tech_id: string | null;
  research_progress: number;
};

export type Message = {
  id: string;
  scope: 'dm' | 'group' | 'broadcast';
  claimed_sender_faction_id: string;
  body: string;
  signed: boolean;
  sent_at_tick: number;
  sent_at_ms: number;
  recipient_faction_ids: string[] | null;
  read_by_caller?: boolean;
};

export type SenateSlider = {
  id: string;
  label: string;
  description: string;
  min: number;
  max: number;
  default: number;
  effective: number;
};

export type SenateProposal = {
  id: string;
  proposer_faction_id: string | null;
  kind: string;
  title: string;
  summary: string;
  payload: any;
  status: 'debating' | 'voting' | 'passed' | 'failed' | 'withdrawn';
  proposed_at_tick: number;
  vote_opens_at_tick: number;
  vote_closes_at_tick: number;
  resolved_at_tick: number | null;
  effect_until_tick: number | null;
  votes?: { yea: number; nay: number; abstain: number };
  my_vote?: 'yea' | 'nay' | 'abstain' | null;
};

// ============================================================
// Trades / Diplomacy
// ============================================================

export type ResourceBundle = {
  metal: number;
  fuel: number;
  gold: number;
  science: number;
};

export type PactKind = 'nap' | 'defense_pact' | 'intel_share';

export const PACT_LABELS: Record<PactKind, string> = {
  nap: 'Non-Aggression',
  defense_pact: 'Defense',
  intel_share: 'Research Sharing',
};

export type TradeStatus = 'open' | 'accepted' | 'declined' | 'cancelled' | 'countered';

export type TradeOffer = {
  id: string;
  proposer_faction_id: string;
  responder_faction_id: string;
  status: TradeStatus;
  offer: ResourceBundle;
  request: ResourceBundle;
  offer_pacts: PactKind[];
  request_pacts: PactKind[];
  parent_offer_id: string | null;
  note: string | null;
  created_at_tick: number;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolved_by_faction_id: string | null;
};

export type Pact = {
  id: string;
  kind: PactKind;
  status: 'active' | 'expired' | 'broken';
  signed_at_tick: number;
  expires_at_tick: number | null;
  counterparty_faction_ids: string[];
};

export type ProposeTradeBody = {
  responder_faction_id: string;
  offer?: Partial<ResourceBundle>;
  request?: Partial<ResourceBundle>;
  offer_pacts?: PactKind[];
  request_pacts?: PactKind[];
  note?: string;
};

export function emptyBundle(): ResourceBundle {
  return { metal: 0, fuel: 0, gold: 0, science: 0 };
}

export function tradesApi(gameId: string) {
  return {
    list(status?: TradeStatus, limit?: number) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      return apiFetch<{ trades: TradeOffer[]; caller_faction_id: string }>(
        `/api/games/${gameId}/trades${qs ? '?' + qs : ''}`,
      );
    },
    propose(body: ProposeTradeBody) {
      return apiFetch<{ trade: TradeOffer }>(`/api/games/${gameId}/trades`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    accept(tradeId: string) {
      return apiFetch<{ trade: TradeOffer; treaties: { id: string; kind: PactKind }[] }>(
        `/api/games/${gameId}/trades/${tradeId}/accept`,
        { method: 'POST' },
      );
    },
    decline(tradeId: string) {
      return apiFetch<null>(`/api/games/${gameId}/trades/${tradeId}/decline`, { method: 'POST' });
    },
    cancel(tradeId: string) {
      return apiFetch<null>(`/api/games/${gameId}/trades/${tradeId}/cancel`, { method: 'POST' });
    },
    counter(tradeId: string, body: Omit<ProposeTradeBody, 'responder_faction_id'>) {
      return apiFetch<{ trade: TradeOffer }>(`/api/games/${gameId}/trades/${tradeId}/counter`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    listPacts() {
      return apiFetch<{ pacts: Pact[]; caller_faction_id: string }>(`/api/games/${gameId}/pacts`);
    },
    breakTreaty(treatyId: string) {
      return apiFetch<{ ok: true; treaty: { id: string; status: 'broken' } }>(
        `/api/games/${gameId}/treaties/${treatyId}/break`,
        { method: 'POST' },
      );
    },
  };
}
