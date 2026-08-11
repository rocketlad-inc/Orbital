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

/**
 * PER-TAB IDENTITY, for agent playtests only.
 *
 * A usability test wants four players on four viewports at once. Cookies
 * are per-origin, not per-tab, so four tabs pointed at the game are all
 * necessarily the same person — which makes a "four player" browser test
 * quietly a one-player test. sessionStorage is the one store the platform
 * scopes to a single tab, so an agent session token parked there lets each
 * tab be a different empire in the same match.
 *
 * NOT AN EXTRA WAY IN. The value has to already be a valid session token,
 * and the server has always accepted that token as a Bearer (see
 * currentSession). This only decides which valid credential a tab
 * presents; it can't manufacture one. Anything able to write here could
 * already act as the logged-in user.
 *
 * Returns null for normal play, so the cookie path below is untouched.
 */
function agentToken(): string | null {
  try {
    return sessionStorage.getItem('orbital_agent_token') || null;
  } catch {
    return null;   // Safari private mode et al. throw on access.
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  // currentSession checks the cookie FIRST and returns on it, so a stale
  // cookie would silently outrank the token and every tab would snap back
  // to one identity. Suppress the cookie entirely when impersonating.
  const agent = agentToken();
  if (agent && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${agent}`);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  const t0 = performance.now();
  let res: Response;
  try {
    // cache: 'no-store' — game API responses must NEVER be served from
    // the browser's HTTP cache. A server-side caching bug once leaked a
    // max-age header onto /state, and every player's browser dutifully
    // served two-minute-old game state from disk ("pressing build does
    // nothing" while six frigates queued server-side). This line makes
    // that entire class of bug impossible from the client side, and it
    // also purges any poisoned entry the moment this bundle loads.
    res = await fetch(path, {
      credentials: agent ? 'omit' : 'same-origin',
      cache: 'no-store',
      ...init,
      headers,
    });
  } catch (e) {
    logger.error('API', `${method} ${path} — network error`, {
      ms: Math.round(performance.now() - t0),
    });
    return { ok: false, status: 0, error: { code: 'network_error', message: 'Network error' } };
  }
  // HTTP 204 No Content is a valid empty success — many worker endpoints
  // (trade decline / cancel, messages read, sign-out, room admin pokes)
  // return `Response(null, { status: 204 })` with no content-type and no
  // body. Without this short-circuit those fall into the non-JSON guard
  // below and the client paints a misleading "Multiplayer backend not
  // running" error even though the action succeeded. Player-reported as
  // "I denied the trade and it said 'Multiplayer backend not running'
  // but then the trade went away as it should."
  if (res.status === 204) {
    const ms = Math.round(performance.now() - t0);
    const silent = method === 'GET' && (
      SILENT_GET_PREFIXES.some(p => path.startsWith(p))
      || SILENT_GET_PATTERNS.some(re => re.test(path))
    );
    if (!silent) logger.info('API', `${method} ${path} 204`, { ms });
    return { ok: true, status: 204, data: null as unknown as T };
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
  // Server-computed (email allow-list). Drives ONLY whether the client
  // renders the Analytics tab — every /api/admin route re-checks.
  is_admin?: boolean;
  // Commander's Commission (cosmetics entitlement). Same trust model as
  // is_admin: unlocks premium pickers in the UI, but every save path
  // re-checks the entitlement server-side.
  is_premium?: boolean;
};

/** Start the Commander's Commission purchase. Resolves to the Stripe
 *  Checkout URL to navigate to, or null when purchases aren't enabled,
 *  the account already owns it, or the request failed. */
export async function startCommissionCheckout(): Promise<string | null> {
  const res = await apiFetch<{ url: string }>('/api/checkout/cosmetics', { method: 'POST' });
  return res.ok ? res.data.url : null;
}

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
  /** Per-member archive stamp (migration 0072). NULL/absent = shows in
   *  My Games; a timestamp files it under Past Games. Archiving is a
   *  view filter only — nothing is deleted and analytics still see it. */
  archived_at_ms?: number | null;
};

export type RoomMember = {
  userId: string;
  displayName: string;
  empire_name?: string | null;
  bio?: string | null;
  chosen_starting_body?: string | null;
  /** Two-tone (§5): primary faction color pref (#rrggbb). Primary carries
   *  meaning; the server rejects only an EXACT duplicate of another
   *  member's primary (409 color_taken). */
  color?: string | null;
  /** Secondary trim color pref — decoration only, free-pick. */
  color2?: string | null;
  /** Flag emblem pref (an EmblemId). Exclusive: the server 409s
   *  `emblem_taken` if another member of the room already flies it. */
  emblem?: string | null;
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
  /** Secondary trim color (two-tone, §5) — decoration only. Null on
   *  legacy rows; derive from `color` client-side when absent. */
  color2?: string | null;
  /** Flag emblem id. Null on factions seeded before migration 0074 —
   *  render through resolveEmblem() so those still draw something. */
  emblem?: string | null;
  status: string;
  capital_body_id: string | null;
  senate_weight: number;
  reputation: number;
  /** Scoreboard extras from the factions endpoint — GATED by the caller's
   *  Sensors research. A rival's income needs Economic Intel (sensors 4),
   *  ship_count needs Fleet Census (sensors 3), tech_levels needs Research
   *  Intel (sensors 6). null = the caller hasn't unlocked that tier (show a
   *  lock); undefined = ungated game / own faction. You always see your own. */
  income?: { metal: number; fuel: number; gold: number; science: number } | null;
  ship_count?: number | null;
  /** Worlds held, and the map total. NOT intel-gated — political borders
   *  are already public, and this is the domination win condition, so
   *  hiding a rival's progress would make the race unreadable. Counted
   *  from the same game_bodies.owner_faction_id the victory check uses. */
  bodies_owned?: number;
  bodies_total?: number;
  /** Systems controlled — the SENATE vote driver (weight = 1 + systems),
   *  computed with the same grouping and plurality rule the chamber uses.
   *  systems_open counts what is still unowned or deadlocked. */
  systems_owned?: number;
  systems_total?: number;
  systems_open?: number;
  /** Senate vote weight (1 seat + 1 per system, 0 if eliminated).
   *  Computed server-side so the "no seat when dead" rule has one home. */
  vote_weight?: number;
  /** Stockpiles. NULL when the caller lacks Economic Intel (Sensors 4)
   *  on this faction — the same gate income uses, so a rival is either
   *  economically legible or not, never half. */
  metal?: number | null;
  gold?: number | null;
  science?: number | null;
  /** Rival tech levels, present only with Research Intel; null when gated. */
  tech_levels?: Record<string, number> | null;
};

export type MyFaction = Faction & {
  metal: number;
  fuel: number;
  gold: number;
  science: number;
  research_tech_id: string | null;
  research_progress: number;
  /** Research context for panels that live outside GameContextProvider
   *  (TradesPanel). Absent on older server responses. */
  tech_levels?: Record<string, number>;
  gating_enabled?: number;
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
  step: number;
  /** Current effective value after applying any active senate_effects
   *  row — resolved FOR THE CALLER, so a law aimed at you is the number
   *  you actually pay. Server emits this as `effective_value`. */
  effective_value: number;
  /** The law binding everyone, ignoring any law aimed at the caller.
   *  Differs from effective_value only when you personally are targeted.
   *  Optional: an older server omits it. */
  general_value?: number;
  /** True when a law names the caller specifically. */
  targeted_at_me?: boolean;
  /** Can this slider be aimed at one faction? False for match-wide knobs
   *  like the tick clock. Optional; treat missing as true. */
  per_faction?: boolean;
};

export type SenateVoteTotals = {
  yea:     { weight: number; count: number };
  nay:     { weight: number; count: number };
  abstain: { weight: number; count: number };
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
  /** Per-proposal deliberation/voting windows (in ticks). Default
   *  values fall through when the row predates the per-proposal cols. */
  debate_ticks: number;
  vote_ticks: number;
  totals: SenateVoteTotals;
  caller_vote: 'yea' | 'nay' | 'abstain' | null;
  // (list response also carries tick_interval_ms at the top level)
  /** Per-faction ballots. Senate votes are public record. */
  ballots?: { faction_id: string; vote: 'yea' | 'nay' | 'abstain'; weight: number }[];
  /** Quorum context as of the read. A bill needs `cast >= required`
   *  engagements — yea, nay, OR abstain — before the tally is even
   *  consulted. Null only on a pre-quorum worker. */
  quorum?: {
    required: number;
    cast: number;
    /** Every non-eliminated faction — the quorum denominator. Idle
     *  players still hold their seat; only elimination removes one. */
    eligible: number;
    met: boolean;
  } | null;
};

/** Who holds the gavel and whether the caller may legislate right now. */
export type SenateSession = {
  term: {
    id: string;
    faction_id: string;
    term_index: number;
    bag_cycle: number;
    start_tick: number;
    end_tick: number;
    ticks_remaining: number;
  } | null;
  term_ticks: number;
  is_chairman: boolean;
  can_propose: boolean;
  /** Human-readable why-not. Present whenever can_propose is false. */
  cannot_propose_reason: string | null;
  floor_busy: boolean;
  /** Factions yet to hold the gavel this cycle. Unordered — the draw is
   *  random within a cycle, so this is "still waiting", not a queue. */
  awaiting_turn: string[];
  quorum: { required: number; eligible: number; eligible_ids: string[] };
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
  /** Physical delivery legs (accepted trades only). Resources no longer
   *  teleport on accept — each giving side ships its goods by freighter,
   *  collector to collector. See TradeDelivery for the lifecycle. */
  deliveries?: TradeDelivery[];
  /** Standing-route offer: amounts are per-run rates; accept strikes a
   *  TradeAgreement instead of one-shot deliveries. */
  recurring?: boolean;
};

/** One shipping leg of an accepted trade.
 *  unassigned → to_pickup → outbound → delivered | lost.
 *  `loaded` flips when the sender's pool is debited at their collector;
 *  from then on the cargo rides the hull (and a killer can loot it). */
export type TradeDelivery = {
  id: string;
  trade_id: string;
  sender_faction_id: string;
  recipient_faction_id: string;
  ship_id: string | null;
  status: 'unassigned' | 'to_pickup' | 'outbound' | 'delivered' | 'lost';
  pickup_body_id: string | null;
  dest_body_id: string | null;
  metal: number; fuel: number; gold: number; science: number;
  loaded: number;
  tariff_pct?: number;
};

export type DeliveryOptions = {
  delivery: { id: string; status: string; metal: number; fuel: number; gold: number; science: number };
  targets: { body_id: string; body_name: string }[];
  freighters: { id: string; name: string; body_id: string; at_collector: boolean }[];
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
  /** Standing trade route: the resource amounts become PER-RUN rates and
   *  accepting strikes a trade_agreement instead of one-shot deliveries.
   *  Resources only — the server rejects recurring offers with pacts. */
  recurring?: boolean;
};

/** A standing trade agreement, shaped from the CALLER's side (the server
 *  resolves who is A and who is B so the client never has to). */
export type TradeAgreement = {
  id: string;
  game_id: string;
  partner_faction_id: string;
  i_send: ResourceBundle;
  i_receive: ResourceBundle;
  /** Receive-side tariff snapshotted when the deal was struck. */
  my_tariff_pct: number;
  status: 'active' | 'ended';
  ended_reason: 'cancelled' | 'starved' | 'war' | 'ship_lost' | 'eliminated' | null;
  ended_at_tick: number | null;
  created_at_tick: number;
  source_offer_id: string | null;
  legs: Array<{
    id: string;
    sender_faction_id: string;
    ship_id: string | null;
    origin_body_id: string;
    dest_body_id: string;
    status: string;
    loops_completed: number;
    /** True when the caller owns this leg (and can commission it). */
    mine: boolean;
  }>;
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
    deliveryOptions(tradeId: string, deliveryId: string) {
      return apiFetch<DeliveryOptions>(
        `/api/games/${gameId}/trades/${tradeId}/delivery-options?delivery=${encodeURIComponent(deliveryId)}`,
      );
    },
    assignDelivery(tradeId: string, deliveryId: string, shipId: string, destBodyId: string) {
      return apiFetch<{ ok: boolean; pickup_body_id: string; dest_body_id: string }>(
        `/api/games/${gameId}/trades/${tradeId}/deliveries/${deliveryId}/assign`,
        { method: 'POST', body: JSON.stringify({ ship_id: shipId, dest_body_id: destBodyId }) },
      );
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
    agreementOptions(agreementId: string) {
      return apiFetch<{ targets: { body_id: string; body_name: string }[];
                        freighters: { id: string; name: string; body_id: string; at_collector: boolean }[] }>(
        `/api/games/${gameId}/trade-agreements/${agreementId}/options`,
      );
    },
    listAgreements(includeEnded = false) {
      return apiFetch<{ agreements: TradeAgreement[] }>(
        `/api/games/${gameId}/trade-agreements${includeEnded ? '?include_ended=1' : ''}`,
      );
    },
    commissionLeg(agreementId: string, shipId: string, destBodyId: string) {
      return apiFetch<{ ok: boolean; route_id: string; origin_body_id: string; dest_body_id: string }>(
        `/api/games/${gameId}/trade-agreements/${agreementId}/commission`,
        { method: 'POST', body: JSON.stringify({ ship_id: shipId, dest_body_id: destBodyId }) },
      );
    },
    cancelAgreement(agreementId: string) {
      return apiFetch<{ ok: boolean }>(
        `/api/games/${gameId}/trade-agreements/${agreementId}/cancel`,
        { method: 'POST' },
      );
    },
    breakTreaty(treatyId: string) {
      return apiFetch<{ ok: true; treaty: { id: string; status: 'broken' } }>(
        `/api/games/${gameId}/treaties/${treatyId}/break`,
        { method: 'POST' },
      );
    },
  };
}

/**
 * "6 ticks · ~6h" — a tick count with its wall-clock meaning attached.
 *
 * Players think in hours; the game thinks in ticks; and tick length is
 * per-game config, so neither side can be hardcoded into the other.
 * Without tickMs (old server, loading) it degrades to plain ticks.
 */
/** Just the wall-clock part, parenthesised: " (~6h)", or '' unknown. */
export function realSuffix(ticks: number, tickMs?: number | null): string {
  const full = fmtTicksReal(ticks, tickMs);
  const i = full.indexOf('· ');
  return i === -1 ? '' : ` (${full.slice(i + 2)})`;
}

export function fmtTicksReal(ticks: number, tickMs?: number | null): string {
  const base = `${ticks} tick${ticks === 1 ? '' : 's'}`;
  if (!tickMs || tickMs <= 0 || ticks <= 0) return base;
  const ms = ticks * tickMs;
  const mins = ms / 60_000;
  const hours = ms / 3_600_000;
  const human = mins < 60
    ? `~${Math.max(1, Math.round(mins))}m`
    : hours < 48
      ? `~${Math.round(hours)}h`
      : `~${Math.round(hours / 24)}d`;
  return `${base} · ${human}`;
}
