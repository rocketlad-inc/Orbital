// ============================================================
// TradesPanel — Civ/Stellaris-style diplomacy hub for a game.
//
// Layout: tabs for [Incoming · Outgoing · Pacts · History], plus
// a "+ New Offer" button that opens TradeComposer.
//
// Polls /api/games/:gameId/trades every 5s, refreshes on any
// inbound WS message from the lobby socket (registered globally).
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  tradesApi,
  TradeOffer,
  TradeDelivery,
  DeliveryOptions,
  Pact,
  PactKind,
  PACT_LABELS,
  Faction,
  MyFaction,
  ResourceBundle,
  TradeAgreement,
} from './api';
import { logUiEvent } from './telemetry';
import { TradeComposer } from './TradeComposer';
import { hasFeature, requirementFor } from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';


/** A delivery leg still doing something (or waiting for someone). */
function legActive(d: TradeDelivery): boolean {
  return d.status !== 'delivered' && d.status !== 'lost';
}

const RESOURCE_COLORS: Record<keyof ResourceBundle, string> = {
  metal: '#a0a0a0',
  gold: '#ffd700',
  science: '#6ee7b7',
};

// FUEL IS GONE FROM THE GAME. It is absent here rather than merely
// unselectable, because this map is what BundleLine iterates: leaving
// the label in printed a "Fuel" row for any legacy offer that still
// carries a non-zero amount, advertising a resource that no longer
// exists and cannot be paid. Legacy rows now read as the metal/gold/
// science they can actually settle in.
const RESOURCE_LABELS: Record<string, string> = {
  metal: 'Metal',
  gold: 'Credits',
  science: 'Science',
};

export function TradesPanel({ gameId }: { gameId: string }) {
  useEffect(() => { logUiEvent(gameId, 'trades'); }, [gameId]);
  const api = useMemo(() => tradesApi(gameId), [gameId]);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [trades, setTrades] = useState<TradeOffer[]>([]);
  const [pacts, setPacts] = useState<Pact[]>([]);
  const [agreements, setAgreements] = useState<TradeAgreement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<
    | { kind: 'new' }
    | { kind: 'counter'; original: TradeOffer }
    | null
  >(null);

  // Trade rides on freighters (hull.freighter, Propulsion 1). This panel
  // mounts OUTSIDE GameContextProvider, so it can't call useFeatureGate
  // (that crashed the trade tab: "useGameContext must be used within
  // GameContextProvider"). Instead /me now returns tech_levels +
  // gating_enabled, and we run the same pure predicate the hook uses.
  const tradeLock = useMemo(() => {
    if (!me) return null; // still loading — don't flash a lock
    const enabled = (me.gating_enabled ?? 0) === 1; // absent (old server) → ungated
    if (hasFeature('hull.freighter', me.tech_levels, enabled)) return null;
    const req = requirementFor('hull.freighter');
    if (!req) return null;
    const track = TECH_DEFS[req.track]?.name ?? req.track;
    return { label: req.label, text: `Unlocks at ${track} ${req.level}` };
  }, [me]);

  const refresh = useCallback(async () => {
    const [meRes, fRes, tRes, pRes, aRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
      api.list(),
      api.listPacts(),
      api.listAgreements(),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (fRes.ok) setFactions(fRes.data.factions);
    if (tRes.ok) setTrades(tRes.data.trades);
    if (pRes.ok) setPacts(pRes.data.pacts);
    if (aRes.ok) setAgreements(aRes.data.agreements);
  }, [gameId, api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const factionsById = useMemo(() => {
    const m = new Map<string, Faction>();
    for (const f of factions) m.set(f.id, f);
    return m;
  }, [factions]);

  const incoming = useMemo(
    () => trades.filter((t) => t.status === 'open' && t.responder_faction_id === me?.id),
    [trades, me],
  );
  const outgoing = useMemo(
    () => trades.filter((t) => t.status === 'open' && t.proposer_faction_id === me?.id),
    [trades, me],
  );
  // Accepted deals whose freighters haven't all landed yet. A deal is
  // no longer "done" at accept — it's done when the goods arrive.
  const shipments = useMemo(
    () => trades.filter(
      (t) => t.status === 'accepted' && (t.deliveries ?? []).some(legActive),
    ),
    [trades],
  );
  // Legs *I* owe that have no freighter yet — the action-needed badge.
  const myUnassigned = useMemo(
    () => shipments.reduce(
      (n, t) => n + (t.deliveries ?? []).filter(
        (d) => d.sender_faction_id === me?.id && d.status === 'unassigned',
      ).length,
      0,
    ),
    [shipments, me],
  );
  const history = useMemo(
    () => trades.filter(
      (t) => t.status !== 'open'
        && !(t.status === 'accepted' && (t.deliveries ?? []).some(legActive)),
    ),
    [trades],
  );

  const handleAction = async (
    fn: () => Promise<{ ok: boolean; error: any }>,
    successMsg?: string,
  ) => {
    setError(null);
    const res = await fn();
    if (!res.ok) {
      setError(res.error?.message ?? 'Action failed');
      return false;
    }
    refresh();
    return true;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* NO SUB-TABS. Trade state is one story told in five parts, and
          hiding four of them behind tabs is why offers expire unread:
          nothing on screen tells you the other drawers have anything in
          them. One scroll, ordered by who owes whom — what THEY need
          from you, then what YOU owe, then what's merely in flight. */}
      <button
        className="mp-btn mp-btn--primary"
        style={{ marginBottom: 8, width: '100%' }}
        onClick={() => setComposerMode({ kind: 'new' })}
        disabled={!me || factions.length < 2 || !!tradeLock}
        title={tradeLock ? `${tradeLock.label} — ${tradeLock.text}` : undefined}
      >
        {tradeLock ? `🔒 New Offer · ${tradeLock.text}` : '+ New Offer'}
      </button>

      {error && (
        <div className="mp-error" style={{ marginBottom: 8 }}>{error}</div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Offers awaiting YOUR answer come first — they're the only
            thing here that goes stale if ignored. */}
        <TradeSection
          title="Awaiting your answer"
          count={incoming.length}
          tone={incoming.length > 0 ? 'urgent' : undefined}
          empty="Nobody has offered you a deal."
        >
          <TradeList
            trades={incoming}
            me={me}
            factionsById={factionsById}
            emptyText=""
            actions={(trade) => (
              <>
                <button
                  className="mp-btn mp-btn--primary"
                  onClick={() =>
                    handleAction(() => api.accept(trade.id) as any)
                  }
                >
                  Accept
                </button>
                <button
                  className="mp-btn"
                  onClick={() => setComposerMode({ kind: 'counter', original: trade })}
                >
                  Counter
                </button>
                <button
                  className="mp-btn"
                  onClick={() =>
                    handleAction(() => api.decline(trade.id) as any)
                  }
                >
                  Decline
                </button>
              </>
            )}
          />
        </TradeSection>

        {/* Then cargo in motion — and specifically legs of it that are
            sitting in a warehouse because you never named a freighter. */}
        <TradeSection
          title="Shipments in motion"
          count={shipments.length}
          badge={myUnassigned > 0
            ? `${myUnassigned} leg${myUnassigned === 1 ? '' : 's'} need a freighter`
            : undefined}
          tone={myUnassigned > 0 ? 'urgent' : undefined}
          empty="Nothing in transit."
        >
          <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginBottom: 8, lineHeight: 1.5 }}>
            Accepted deals ship physically: each side loads its goods onto a
            freighter at one of its <b>terraformed worlds</b>, and the cargo
            lands in the other side's pool on arrival. Freighters can be
            raided — escort what you can't afford to lose.
          </div>
          <TradeList
            trades={shipments}
            me={me}
            factionsById={factionsById}
            emptyText=""
            gameId={gameId}
            api={api}
            onChanged={refresh}
          />
        </TradeSection>

        {/* Standing routes: contracts that repeat until stopped. Sits
            right after the one-shot shipments because the badge logic is
            the same story — "your leg needs a freighter" is the one
            state that goes nowhere without you. */}
        <TradeSection
          title="Standing routes"
          count={agreements.length}
          badge={(() => {
            const n = agreements.filter(a =>
              a.status === 'active'
              && sendsSomething(a.i_send)
              && !a.legs.some(l => l.mine)).length;
            return n > 0 ? `${n} route${n === 1 ? '' : 's'} need a freighter` : undefined;
          })()}
          tone={agreements.some(a =>
            a.status === 'active' && sendsSomething(a.i_send) && !a.legs.some(l => l.mine))
            ? 'urgent' : undefined}
          empty="No standing trade routes. Propose one with the Standing route option in a new offer."
        >
          {agreements.map(a => (
            <AgreementCard
              key={a.id}
              agreement={a}
              factionsById={factionsById}
              api={api}
              onChanged={refresh}
            />
          ))}
        </TradeSection>

        <TradeSection
          title="Your offers out"
          count={outgoing.length}
          empty="You have no offers on the table."
        >
          <TradeList
            trades={outgoing}
            me={me}
            factionsById={factionsById}
            emptyText=""
            actions={(trade) => (
              <button
                className="mp-btn"
                onClick={() =>
                  handleAction(() => api.cancel(trade.id) as any)
                }
              >
                Withdraw
              </button>
            )}
          />
        </TradeSection>

        <TradeSection
          title="Standing pacts"
          count={pacts.length}
          empty="No pacts in force."
        >
          <PactsList pacts={pacts} factionsById={factionsById} />
        </TradeSection>

        {/* Settled business folds away: it's a record, not a decision,
            and it grows without bound. */}
        <TradeSection
          title="Settled"
          count={history.length}
          collapsible
          empty="No resolved trades yet."
        >
          <TradeList
            trades={history}
            me={me}
            factionsById={factionsById}
            emptyText=""
            showStatus
            api={api}
            onChanged={refresh}
          />
        </TradeSection>
      </div>

      {composerMode && me && (
        <TradeComposer
          gameId={gameId}
          me={me}
          factions={factions}
          mode={composerMode}
          onClose={() => setComposerMode(null)}
          onSuccess={() => {
            setComposerMode(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------

/**
 * One band of the trade ledger.
 *
 * Every section shows its count even when it's zero, because the count IS
 * the information: "Awaiting your answer 0" is a state worth reading, and
 * a tab you never opened is not. Empty sections collapse to a single dim
 * line rather than a padded box, so five of them cost five lines.
 */
function TradeSection({
  title, count, badge, tone, empty, collapsible, children,
}: {
  title: string;
  count: number;
  badge?: string;
  tone?: 'urgent';
  empty: string;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  // Settled business starts folded; anything actionable starts open.
  const [open, setOpen] = useState(!collapsible);
  const isEmpty = count === 0;
  const foldable = collapsible && !isEmpty;
  return (
    <section className={`tp-sec${tone === 'urgent' ? ' is-urgent' : ''}`}>
      <div
        className={`tp-sec__h${foldable ? ' is-foldable' : ''}`}
        onClick={foldable ? () => setOpen((v) => !v) : undefined}
        role={foldable ? 'button' : undefined}
        tabIndex={foldable ? 0 : undefined}
        onKeyDown={foldable
          ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
          }
          : undefined}
        aria-expanded={foldable ? open : undefined}
      >
        {foldable && <span className="tp-sec__caret">{open ? '▾' : '▸'}</span>}
        <span className="tp-sec__t">{title}</span>
        <span className="tp-sec__n">{count}</span>
        {badge && <span className="tp-sec__badge">{badge}</span>}
      </div>
      {isEmpty
        ? <div className="tp-sec__empty">{empty}</div>
        : open && <div className="tp-sec__body">{children}</div>}
    </section>
  );
}

function TradeList({
  trades, me, factionsById, actions, emptyText, showStatus, gameId, api, onChanged,
}: {
  trades: TradeOffer[];
  me: MyFaction | null;
  factionsById: Map<string, Faction>;
  actions?: (trade: TradeOffer) => React.ReactNode;
  emptyText: string;
  showStatus?: boolean;
  gameId?: string;
  api?: ReturnType<typeof tradesApi>;
  onChanged?: () => void;
}) {
  // The section header owns the empty state now; an empty list here just
  // renders nothing rather than a second, redundant "nothing to see".
  if (!trades.length) {
    return emptyText
      ? <div className="mp-empty" style={{ textAlign: 'center', padding: 16, color: '#b8c8d6' }}>{emptyText}</div>
      : null;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {trades.map((trade) => (
        <TradeCard
          key={trade.id}
          trade={trade}
          me={me}
          factionsById={factionsById}
          actions={actions}
          showStatus={showStatus}
          api={api}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function TradeCard({
  trade, me, factionsById, actions, showStatus, api, onChanged,
}: {
  trade: TradeOffer;
  me: MyFaction | null;
  factionsById: Map<string, Faction>;
  actions?: (trade: TradeOffer) => React.ReactNode;
  showStatus?: boolean;
  api?: ReturnType<typeof tradesApi>;
  onChanged?: () => void;
}) {
  const proposer = factionsById.get(trade.proposer_faction_id);
  const responder = factionsById.get(trade.responder_faction_id);
  const isMineOutgoing = me?.id === trade.proposer_faction_id;

  // From caller's perspective: 'you give' = whichever side caller is on
  const youGive: ResourceBundle = isMineOutgoing ? trade.offer : trade.request;
  const youGivePacts: PactKind[] = isMineOutgoing ? trade.offer_pacts : trade.request_pacts;
  const theyGive: ResourceBundle = isMineOutgoing ? trade.request : trade.offer;
  const theyGivePacts: PactKind[] = isMineOutgoing ? trade.request_pacts : trade.offer_pacts;
  const otherParty = isMineOutgoing ? responder : proposer;

  return (
    <div className="tp-row">
      {/* ONE LINE, not a three-column grid. "You give / ⇄ / You receive"
          spent a third of a 376px sidebar on an arrow and stacked each
          side's resources vertically, so a two-resource swap ran five
          lines tall. The deal reads as a sentence instead. */}
      <div className="tp-row__t">
        <span className="tp-row__dot" style={{ background: otherParty?.color ?? '#8aa0b4' }} />
        <span className="tp-row__nm" style={{ color: otherParty?.color ?? 'var(--mp-fg)' }}>
          {otherParty?.name ?? 'unknown'}
        </span>
        {showStatus && (
          <span
            className="tp-pill"
            style={{ color: dealColor(trade), borderColor: dealColor(trade) }}
            title={agreementEndText(trade, me?.id, otherParty?.name) ?? undefined}
          >
            {dealLabel(trade)}
          </span>
        )}
      </div>

      {agreementEndText(trade, me?.id, otherParty?.name) && (
        <div className="tp-row__ended">
          {agreementEndText(trade, me?.id, otherParty?.name)}
        </div>
      )}

      <div className="tp-row__d">
        <BundleLine label="They send" bundle={theyGive} pacts={theyGivePacts} />
        <span className="tp-row__sep"> · </span>
        <BundleLine label="you send" bundle={youGive} pacts={youGivePacts} />
      </div>

      {/* DO I NEED A FREIGHTER? The one thing a standing offer never
          said. A proposer pins a hull when they make the offer, and
          accepting starts the lane on it in BOTH directions — so the
          responder commissions nothing. The server has acted on that
          since the pin shipped; the panel never mentioned it, leaving
          the person accepting to go hunting for a freighter they don't
          need, or to leave the deal idle waiting for one. */}
      {trade.recurring && trade.status === 'open' && (
        <div className="tp-row__hull">
          {trade.offered_ship_id
            ? (isMineOutgoing
              ? <>You've committed <b>{trade.offered_ship_name ?? 'a freighter'}</b> to this run
                  — it starts hauling the moment they accept.</>
              : <><b>{otherParty?.name ?? 'They'}</b> has committed{' '}
                  <b>{trade.offered_ship_name ?? 'a freighter'}</b> to fly it. Accept and the lane
                  starts at once, collecting and delivering at both ends —{' '}
                  <b>you don't need to assign a freighter.</b></>)
            : (isMineOutgoing
              ? <>No freighter pinned — you'll each commission one from the Trades panel after
                  they accept.</>
              : <>No freighter pinned to this offer — after accepting, each side commissions one
                  before anything ships.</>)}
        </div>
      )}

      {trade.note && (
        <div style={{ marginTop: 6, fontSize: 10, fontStyle: 'italic', color: '#a8b8c8' }}>
          "{trade.note}"
        </div>
      )}

      {trade.parent_offer_id && (
        <div style={{ marginTop: 4, fontSize: 9, color: '#b8c8d6' }}>
          ↳ counter-offer
        </div>
      )}

      {/* Delivery legs — accepted trades only. Each giving side ships
          its goods physically; this is where the caller assigns a
          freighter to the legs THEY owe and watches both convoys. */}
      {trade.status === 'accepted' && (trade.deliveries ?? []).length > 0 && api && (
        <div style={{ marginTop: 8, borderTop: '1px solid #2a3d50', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(trade.deliveries ?? []).map((d) => (
            <DeliveryLegRow
              key={d.id}
              trade={trade}
              delivery={d}
              me={me}
              factionsById={factionsById}
              api={api}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {actions && (
        // Wrapping + stretch, not flex-end: three buttons on a narrow
        // panel overflowed LEFT (flex-end pushes overflow off-screen),
        // clipping ACCEPT. Class lives in multiplayer.css.
        <div className="mp-trade__actions">
          {actions(trade)}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Delivery legs

const LEG_STATUS_TEXT: Record<string, string> = {
  to_pickup: 'freighter heading to your dock to load',
  outbound: 'cargo aboard — en route to their world',
  delivered: 'delivered',
  lost: 'freighter destroyed — cargo lost',
};

function legManifest(d: TradeDelivery): string {
  const bits: string[] = [];
  // Round for display — bundle amounts can carry server-side fp residue.
  if (d.metal) bits.push(`${Math.round(d.metal)}M`);
  if (d.fuel) bits.push(`${Math.round(d.fuel)}F`);
  if (d.gold) bits.push(`${Math.round(d.gold)}C`);
  if (d.science) bits.push(`${Math.round(d.science)}S`);
  return bits.join(' ') || 'nothing';
}

function DeliveryLegRow({
  trade, delivery, me, factionsById, api, onChanged,
}: {
  trade: TradeOffer;
  delivery: TradeDelivery;
  me: MyFaction | null;
  factionsById: Map<string, Faction>;
  api: ReturnType<typeof tradesApi>;
  onChanged?: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const mine = delivery.sender_faction_id === me?.id;
  const sender = factionsById.get(delivery.sender_faction_id);
  const icon =
    delivery.status === 'delivered' ? '✓'
    : delivery.status === 'lost' ? '✸'
    : delivery.status === 'unassigned' ? '⚠'
    : '⇢';
  const color =
    delivery.status === 'delivered' ? '#6ee7b7'
    : delivery.status === 'lost' ? '#ff5e5e'
    : delivery.status === 'unassigned' ? (mine ? '#ffb84d' : '#8aa0b4')
    : '#4ecdc4';

  const statusText = delivery.status === 'unassigned'
    ? (mine
        ? 'needs a freighter — nothing ships until you assign one'
        : `waiting for ${sender?.name ?? 'them'} to assign a freighter`)
    : (mine
        ? LEG_STATUS_TEXT[delivery.status] ?? delivery.status
        : delivery.status === 'outbound'
          ? 'their cargo is aboard — inbound to your world'
          : delivery.status === 'to_pickup'
            ? 'their freighter is heading out to load'
            : LEG_STATUS_TEXT[delivery.status] ?? delivery.status);

  return (
    <div style={{ fontSize: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color }}>{icon}</span>
        <span style={{ color: '#d8e4ee' }}>
          {mine ? 'You send' : `${sender?.name ?? 'They'} sends`}{' '}
          <b>{legManifest(delivery)}</b>
        </span>
        <span style={{ color, flex: 1 }}>— {statusText}</span>
        {mine && delivery.status === 'unassigned' && (
          <button className="mp-btn mp-btn--primary" style={{ fontSize: 9, padding: '2px 8px' }}
            onClick={() => setAssigning(a => !a)}>
            {assigning ? 'Close' : 'Assign freighter'}
          </button>
        )}
      </div>
      {assigning && (
        <AssignShipmentForm
          trade={trade}
          delivery={delivery}
          api={api}
          onDone={() => { setAssigning(false); onChanged?.(); }}
        />
      )}
    </div>
  );
}

function AssignShipmentForm({
  trade, delivery, api, onDone,
}: {
  trade: TradeOffer;
  delivery: TradeDelivery;
  api: ReturnType<typeof tradesApi>;
  onDone: () => void;
}) {
  const [opts, setOpts] = useState<DeliveryOptions | null>(null);
  const [shipId, setShipId] = useState('');
  const [destId, setDestId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    api.deliveryOptions(trade.id, delivery.id).then((res) => {
      if (dead) return;
      if (!res.ok) { setErr(res.error?.message ?? 'Could not load options'); return; }
      setOpts(res.data);
      // Preselect the obvious choices: a freighter already sitting at
      // one of your collectors (instant load), and the only target if
      // there is only one.
      const atDock = res.data.freighters.find(f => f.at_collector);
      setShipId((atDock ?? res.data.freighters[0])?.id ?? '');
      setDestId(res.data.targets[0]?.body_id ?? '');
    });
    return () => { dead = true; };
  }, [api, trade.id, delivery.id]);

  const submit = async () => {
    if (!shipId || !destId) return;
    setBusy(true); setErr(null);
    const res = await api.assignDelivery(trade.id, delivery.id, shipId, destId);
    setBusy(false);
    if (!res.ok) { setErr(res.error?.message ?? 'Assign failed'); return; }
    onDone();
  };

  if (err && !opts) return <div className="mp-error" style={{ marginTop: 4 }}>{err}</div>;
  if (!opts) return <div style={{ color: '#8aa0b4', marginTop: 4 }}>Loading options…</div>;

  return (
    <div style={{ marginTop: 6, padding: 6, border: '1px solid #2a3d50', borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {opts.freighters.length === 0 ? (
        <div style={{ color: '#ffb84d' }}>
          No idle freighter. Build one, or free one from its trade route —
          this shipment waits until a hull is available.
        </div>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: '#8aa0b4' }}>
            FREIGHTER
            <select value={shipId} onChange={(e) => setShipId(e.target.value)}
              style={{ background: '#0a0e14', color: '#d8e4ee', border: '1px solid #2a3d50', fontFamily: 'inherit', fontSize: 10, padding: 3 }}>
              {opts.freighters.map(f => (
                <option key={f.id} value={f.id}>
                  {f.name}{f.at_collector ? ' · at the dock (loads instantly)' : ' · will burn to your nearest dock first'}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: '#8aa0b4' }}>
            DELIVER TO (their terraformed world)
            <select value={destId} onChange={(e) => setDestId(e.target.value)}
              style={{ background: '#0a0e14', color: '#d8e4ee', border: '1px solid #2a3d50', fontFamily: 'inherit', fontSize: 10, padding: 3 }}>
              {opts.targets.map(t => (
                <option key={t.body_id} value={t.body_id}>{t.body_name}</option>
              ))}
            </select>
          </label>
          {err && <div className="mp-error">{err}</div>}
          <button className="mp-btn mp-btn--primary" disabled={busy || !shipId || !destId} onClick={submit}>
            {busy ? 'Assigning…' : 'Launch shipment'}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * One half of a deal, inline: "They send 4.0k credits, 2 Non-Aggression".
 *
 * Resource colours are the same ones the rest of the game uses, so metal
 * reads as metal without a legend.
 */
function BundleLine({
  label, bundle, pacts,
}: {
  label: string;
  bundle: ResourceBundle;
  pacts: PactKind[];
}) {
  const parts: React.ReactNode[] = [];
  (Object.keys(RESOURCE_LABELS) as (keyof ResourceBundle)[]).forEach((k) => {
    const v = bundle[k];
    if (!v) return;
    parts.push(
      <span key={k} style={{ color: RESOURCE_COLORS[k] }}>
        {fmtAmount(v)} {RESOURCE_LABELS[k].toLowerCase()}
      </span>,
    );
  });
  for (const pk of pacts ?? []) {
    parts.push(<span key={`p:${pk}`} style={{ color: '#4ecdc4' }}>{PACT_LABELS[pk]}</span>);
  }
  return (
    <>
      <span className="tp-row__lbl">{label} </span>
      {parts.length === 0
        ? <span className="tp-row__nil">nothing</span>
        : parts.map((el, i) => (
          <React.Fragment key={i}>{i > 0 ? ', ' : ''}{el}</React.Fragment>
        ))}
    </>
  );
}

/** 4000 -> "4.0k". Trade amounts run to five digits and the sidebar is
 *  376px wide. */
function fmtAmount(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function PactsList({
  pacts, factionsById,
}: {
  pacts: Pact[];
  factionsById: Map<string, Faction>;
}) {
  if (!pacts.length) {
    return <div className="mp-empty" style={{ textAlign: 'center', padding: 16, color: '#b8c8d6' }}>No active pacts.</div>;
  }
  return (
    <>
      {pacts.map((p) => (
        <div key={p.id} className="tp-row is-pact">
          <div className="tp-row__t">
            <span className="tp-row__dot" style={{ background: '#4ecdc4' }} />
            <span className="tp-row__nm" style={{ color: '#4ecdc4' }}>
              {PACT_LABELS[p.kind]}
            </span>
            <span className="tp-pill" style={{ color: '#4ecdc4', borderColor: '#4ecdc4' }}>
              in force
            </span>
          </div>
          <div className="tp-row__d">
            with{' '}
            {p.counterparty_faction_ids.map((id, i) => {
              const f = factionsById.get(id);
              return (
                <span key={id} style={{ color: f?.color ?? 'var(--mp-fg)' }}>
                  {f?.name ?? id}{i < p.counterparty_faction_ids.length - 1 ? ', ' : ''}
                </span>
              );
            })}
            <span className="tp-row__when">
              {' '}· signed T+{p.signed_at_tick}
              {p.expires_at_tick != null && ` · expires T+${p.expires_at_tick}`}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

/** What became of a standing agreement, in the player's words. null when
 *  the deal never became an agreement or is still running. */
function agreementEndText(
  trade: TradeOffer,
  myFactionId?: string,
  partnerName?: string,
): string | null {
  if (trade.agreement_status !== 'ended') return null;
  const at = trade.agreement_ended_at_tick;
  const when = at != null ? ` (tick ${at})` : '';
  switch (trade.agreement_ended_reason) {
    case 'starved': {
      // Name WHO ran dry. "a shipment could not be covered" left both
      // parties assuming it was the other one who failed to pay.
      const by = trade.agreement_ended_by_faction_id;
      const who = by == null ? 'a side'
        : by === myFactionId ? 'you'
        : (partnerName ?? 'your partner');
      return `Ended${when} — ${who} could not cover the shipment for 10 ticks running.`;
    }
    case 'war':       return `Ended${when} — you exchanged fire.`;
    case 'ship_lost': return `Ended${when} — a freighter on the route was destroyed.`;
    case 'eliminated':return `Ended${when} — a party was eliminated.`;
    case 'cancelled': return `Called off${when}.`;
    default:          return `Ended${when}.`;
  }
}

/** The badge should read as the DEAL's state, not the handshake's. */
function dealLabel(trade: TradeOffer): string {
  if (trade.agreement_status === 'ended') {
    return trade.agreement_ended_reason === 'cancelled' ? 'called off' : 'ended';
  }
  if (trade.agreement_status === 'active') return 'running';
  return trade.status;
}

function dealColor(trade: TradeOffer): string {
  if (trade.agreement_status === 'ended') {
    return trade.agreement_ended_reason === 'cancelled' ? '#b8c8d6' : '#ff5e5e';
  }
  if (trade.agreement_status === 'active') return '#6ee7b7';
  return statusColor(trade.status);
}

function statusColor(status: string): string {
  switch (status) {
    case 'accepted': return '#6ee7b7';
    case 'declined': return '#ff5e5e';
    case 'cancelled': return '#b8c8d6';
    case 'countered': return '#ffb84d';
    default: return '#a8b8c8';
  }
}

// ============================================================
// Standing routes
// ============================================================

function sendsSomething(b: ResourceBundle): boolean {
  return (b.metal + b.gold + b.science) > 0;
}

function bundleText(b: ResourceBundle): string {
  const bits: string[] = [];
  for (const k of ['metal', 'gold', 'science'] as const) {
    if (b[k] > 0) bits.push(`${b[k]} ${RESOURCE_LABELS[k].toLowerCase()}`);
  }
  return bits.length ? bits.join(' · ') : 'nothing';
}

const ENDED_REASON_TEXT: Record<string, string> = {
  cancelled: 'called off',
  starved: 'ended — a shipment couldn\'t be covered',
  war: 'ended — you exchanged fire',
  ship_lost: 'ended — a freighter was destroyed',
  eliminated: 'ended — a party was eliminated',
};

function AgreementCard({
  agreement: a, factionsById, api, onChanged,
}: {
  agreement: TradeAgreement;
  factionsById: Map<string, Faction>;
  api: ReturnType<typeof tradesApi>;
  onChanged: () => void;
}) {
  const [commissioning, setCommissioning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const partner = factionsById.get(a.partner_faction_id);
  const myLeg = a.legs.find(l => l.mine);
  const theirLeg = a.legs.find(l => !l.mine);
  const iShip = sendsSomething(a.i_send);
  const theyShip = sendsSomething(a.i_receive);

  // ONE LANE, BOTH WAYS. A folded lane belongs to whichever side leads
  // it and hauls for both, which breaks every inference this card used
  // to make from "my leg / their leg": with the lane on their hull, I
  // have no leg of my own and was told to commission a freighter for
  // goods already moving — and they were reported as owing one while
  // their cargo rode mine. Once a lane is folded, it is THE lane.
  const lane = a.legs.find(l => l.consolidated) ?? null;
  const crew = lane?.carriers ?? [];
  const iHaveHullOnLane = crew.some(c => c.mine);
  const theyHaveHullOnLane = crew.some(c => !c.mine);
  // Split state: a folded lane AND a stray one-way leg beside it, from a
  // partner who commissioned after the fold.
  const split = !!lane && a.legs.length > 1;
  const needsMe = a.status === 'active' && iShip && !myLeg && !lane;

  const cancel = async () => {
    // "Both legs stop" is false once a deal is folded — there is one
    // lane, and it is carrying for both of you. Name what actually
    // stops, since this is the confirm for an irreversible action.
    const what = lane
      ? `The shared lane stops${crew.length > 1 ? ' and both freighters come free' : ''}.`
      : 'Both legs stop.';
    if (!window.confirm(
      `End your standing route with ${partner?.name ?? 'this empire'}? ${what}`)) return;
    setBusy(true); setErr(null);
    const res = await api.cancelAgreement(a.id);
    setBusy(false);
    if (!res.ok) { setErr(res.error?.message ?? 'Cancel failed'); return; }
    onChanged();
  };

  return (
    <div style={{
      border: '1px solid #2a3d50', borderRadius: 4, padding: 8, marginBottom: 6,
      fontSize: 10, opacity: a.status === 'ended' ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: a.status === 'active' ? '#6ee7b7' : '#8aa0b4' }}>
          {a.status === 'active' ? '⟳' : '⏹'}
        </span>
        <span style={{ color: '#d8e4ee', flex: 1 }}>
          Route with <b style={{ color: partner?.color ?? '#d8e4ee' }}>{partner?.name ?? 'unknown'}</b>
          {a.status === 'ended' && a.ended_reason && (
            <span style={{ color: '#ff5e5e' }}> — {ENDED_REASON_TEXT[a.ended_reason] ?? a.ended_reason}</span>
          )}
        </span>
        {a.status === 'active' && (
          <button className="mp-btn" style={{ fontSize: 9, padding: '2px 8px' }}
            disabled={busy} onClick={cancel}>
            End route
          </button>
        )}
      </div>

      <div style={{ marginTop: 4, color: '#b8c8d6', lineHeight: 1.6 }}>
        {/* THE TERMS, which are true either way. */}
        {iShip && (
          <div>
            ▲ You ship <b>{bundleText(a.i_send)}</b> per run
            {!lane && (myLeg
              ? <span style={{ color: '#6ee7b7' }}>
                  {' '}— running · {myLeg.loops_completed} run{myLeg.loops_completed === 1 ? '' : 's'} completed
                </span>
              : a.status === 'active'
                ? <span style={{ color: '#ffb84d' }}> — needs a freighter; nothing ships until you commission one</span>
                : null)}
          </div>
        )}
        {theyShip && (
          <div>
            ▼ They ship <b>{bundleText(a.i_receive)}</b> per run
            {a.my_tariff_pct > 0 && <span> (you receive −{a.my_tariff_pct}% tariff)</span>}
            {!lane && (theirLeg
              ? <span style={{ color: '#6ee7b7' }}>
                  {' '}— running · {theirLeg.loops_completed} run{theirLeg.loops_completed === 1 ? '' : 's'} completed
                </span>
              : a.status === 'active'
                ? <span style={{ color: '#8aa0b4' }}> — waiting for {partner?.name ?? 'them'} to commission a freighter</span>
                : null)}
          </div>
        )}

        {/* THE LANE. When the deal is folded, the per-direction status
            above is meaningless — there is one circuit and it carries
            both ways — so it is replaced rather than added to. */}
        {lane && (
          <div className="tp-lane">
            <div className="tp-lane__hd">
              ⇄ One lane, both directions
              <span className="tp-lane__runs">
                {lane.loops_completed > 0
                  ? `${lane.loops_completed} run${lane.loops_completed === 1 ? '' : 's'} completed`
                  : 'no runs yet'}
              </span>
            </div>
            <div className="tp-lane__crew">
              {crew.length > 0
                ? <>Flown by {crew.map((cr, i) => (
                    <React.Fragment key={cr.ship_id}>
                      {i > 0 && ', '}
                      <b style={{ color: cr.mine ? '#6ee7b7' : (partner?.color ?? '#d8e4ee') }}>
                        {cr.name ?? 'a freighter'}
                      </b>
                    </React.Fragment>
                  ))}
                  {' '}— each collects and delivers at both ends.</>
                : <span style={{ color: '#ffb84d' }}>
                    No freighter on it. Nothing moves until one is assigned.
                  </span>}
            </div>
            {/* The question the old copy got wrong in both directions. */}
            {crew.length > 0 && (
              <div className="tp-lane__owe">
                {iHaveHullOnLane && theyHaveHullOnLane
                  ? 'Both of you have a hull on it — neither side owes a freighter.'
                  : iHaveHullOnLane
                    ? `Your freighter carries both sides' goods. ${partner?.name ?? 'They'} need not commission one — though a second hull would double the run.`
                    : `${partner?.name ?? 'Their'} freighter carries your goods too. You need not commission one — though adding yours would double the run.`}
              </div>
            )}
            {lane.stalled_since_tick != null && (
              <div className="tp-lane__warn">
                Stalled — this lane cancels itself unless a freighter is assigned.
              </div>
            )}
          </div>
        )}

        {/* Two routes serving one deal: the shape a partner leaves behind
            by commissioning after a fold. Fixed at the source, but a game
            already carrying it needs the way out named here too, since
            this panel is where the deal is managed. */}
        {split && a.status === 'active' && (
          <div className="tp-lane__warn">
            This deal is also running a one-way leg beside the lane. Merge them from the
            route's card in Empire → Trade so every freighter works both ends.
          </div>
        )}
      </div>

      {needsMe && (
        <button className="mp-btn mp-btn--primary" style={{ fontSize: 9, padding: '2px 8px', marginTop: 6 }}
          onClick={() => setCommissioning(c => !c)}>
          {commissioning ? 'Close' : 'Commission freighter'}
        </button>
      )}
      {commissioning && (
        <CommissionForm
          agreement={a}
          api={api}
          onDone={() => { setCommissioning(false); onChanged(); }}
        />
      )}
      {err && <div className="mp-error" style={{ marginTop: 4 }}>{err}</div>}
    </div>
  );
}

/** Freighter + destination picker for the caller's leg. Same interaction
 *  as AssignShipmentForm above — players who have shipped a one-off
 *  already know it — except it happens once per route, not per run. */
function CommissionForm({
  agreement, api, onDone,
}: {
  agreement: TradeAgreement;
  api: ReturnType<typeof tradesApi>;
  onDone: () => void;
}) {
  const [opts, setOpts] = useState<{ targets: { body_id: string; body_name: string }[];
    freighters: { id: string; name: string; body_id: string; at_collector: boolean }[] } | null>(null);
  const [shipId, setShipId] = useState('');
  const [destId, setDestId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    api.agreementOptions(agreement.id).then((res) => {
      if (dead) return;
      if (!res.ok) { setErr(res.error?.message ?? 'Could not load options'); return; }
      setOpts(res.data);
      const atDock = res.data.freighters.find(f => f.at_collector);
      setShipId((atDock ?? res.data.freighters[0])?.id ?? '');
      setDestId(res.data.targets[0]?.body_id ?? '');
    });
    return () => { dead = true; };
  }, [api, agreement.id]);

  const submit = async () => {
    if (!shipId || !destId) return;
    setBusy(true); setErr(null);
    const res = await api.commissionLeg(agreement.id, shipId, destId);
    setBusy(false);
    if (!res.ok) { setErr(res.error?.message ?? 'Commission failed'); return; }
    onDone();
  };

  if (err && !opts) return <div className="mp-error" style={{ marginTop: 4 }}>{err}</div>;
  if (!opts) return <div style={{ color: '#8aa0b4', marginTop: 4 }}>Loading options…</div>;

  return (
    <div style={{ marginTop: 6, padding: 6, border: '1px solid #2a3d50', borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10 }}>
      {opts.freighters.length === 0 ? (
        <div style={{ color: '#ffb84d' }}>
          No idle freighter. Build one, or free one up — this route sits
          idle until a hull is pinned to it.
        </div>
      ) : opts.targets.length === 0 ? (
        <div style={{ color: '#ffb84d' }}>
          Your partner has no collector to receive at. The route can't run
          until they build one.
        </div>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: '#8aa0b4' }}>
            FREIGHTER — pinned to this route until it ends
            <select value={shipId} onChange={(e) => setShipId(e.target.value)}
              style={{ background: '#0a0e14', color: '#d8e4ee', border: '1px solid #2a3d50', fontFamily: 'inherit', fontSize: 10, padding: 3 }}>
              {opts.freighters.map(f => (
                <option key={f.id} value={f.id}>
                  {f.name}{f.at_collector ? ' · at the dock (loads instantly)' : ' · will burn to your nearest dock first'}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: '#8aa0b4' }}>
            DELIVER TO
            <select value={destId} onChange={(e) => setDestId(e.target.value)}
              style={{ background: '#0a0e14', color: '#d8e4ee', border: '1px solid #2a3d50', fontFamily: 'inherit', fontSize: 10, padding: 3 }}>
              {opts.targets.map(t => (
                <option key={t.body_id} value={t.body_id}>{t.body_name}</option>
              ))}
            </select>
          </label>
          <button className="mp-btn mp-btn--primary" style={{ fontSize: 9, alignSelf: 'flex-start' }}
            disabled={busy || !shipId || !destId} onClick={submit}>
            {busy ? 'Starting…' : 'Start the route'}
          </button>
        </>
      )}
      {err && <div className="mp-error">{err}</div>}
    </div>
  );
}
