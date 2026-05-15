// Thin fetch wrapper for the Worker API. All endpoints are same-origin in
// production; in dev the CRA proxy (src/setupProxy.js) forwards /api/* to
// wrangler dev.

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code: string; message: string } | null };

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  } catch {
    return { ok: false, status: 0, error: { code: 'network_error', message: 'Network error' } };
  }
  // The dev server falls back to index.html for unknown routes, which would
  // come back as `200 text/html`. Reject anything that isn't JSON so the
  // worker-less dev mode reads as "unauthenticated" instead of crashing.
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return { ok: false, status: res.status, error: { code: 'no_backend', message: 'Multiplayer backend not running' } };
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
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
  total_tick_target?: number;
  tick_interval_ms?: number;
  game_id?: string | null;
  game_status?: string | null;
};

export type RoomMember = {
  userId: string;
  displayName: string;
  empire_name?: string | null;
  bio?: string | null;
};

export type RoomSettings = {
  id: string;
  name: string;
  host_id: string;
  status: string;
  max_players: number;
  invite_code?: string | null;
  has_password?: boolean;
  total_tick_target: number;
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
  };
}
