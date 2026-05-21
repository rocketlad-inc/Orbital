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
  Pact,
  PactKind,
  PACT_LABELS,
  Faction,
  MyFaction,
  ResourceBundle,
} from './api';
import { TradeComposer } from './TradeComposer';

type Tab = 'incoming' | 'outgoing' | 'pacts' | 'history';

const RESOURCE_COLORS: Record<keyof ResourceBundle, string> = {
  metal: '#a0a0a0',
  fuel: '#ffb84d',
  gold: '#ffd700',
  science: '#6ee7b7',
};

const RESOURCE_LABELS: Record<keyof ResourceBundle, string> = {
  metal: 'Metal',
  fuel: 'Fuel',
  gold: 'Gold',
  science: 'Science',
};

export function TradesPanel({ gameId }: { gameId: string }) {
  const api = useMemo(() => tradesApi(gameId), [gameId]);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [trades, setTrades] = useState<TradeOffer[]>([]);
  const [pacts, setPacts] = useState<Pact[]>([]);
  const [tab, setTab] = useState<Tab>('incoming');
  const [error, setError] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<
    | { kind: 'new' }
    | { kind: 'counter'; original: TradeOffer }
    | null
  >(null);

  const refresh = useCallback(async () => {
    const [meRes, fRes, tRes, pRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
      api.list(),
      api.listPacts(),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (fRes.ok) setFactions(fRes.data.factions);
    if (tRes.ok) setTrades(tRes.data.trades);
    if (pRes.ok) setPacts(pRes.data.pacts);
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
  const history = useMemo(
    () => trades.filter((t) => t.status !== 'open'),
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
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <TabButton active={tab === 'incoming'} onClick={() => setTab('incoming')} count={incoming.length}>
          Incoming
        </TabButton>
        <TabButton active={tab === 'outgoing'} onClick={() => setTab('outgoing')} count={outgoing.length}>
          Outgoing
        </TabButton>
        <TabButton active={tab === 'pacts'} onClick={() => setTab('pacts')} count={pacts.length}>
          Pacts
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History
        </TabButton>
      </div>

      <button
        className="mp-btn-primary"
        style={{ marginBottom: 8, width: '100%' }}
        onClick={() => setComposerMode({ kind: 'new' })}
        disabled={!me || factions.length < 2}
      >
        + New Offer
      </button>

      {error && (
        <div className="mp-error" style={{ marginBottom: 8 }}>{error}</div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'incoming' && (
          <TradeList
            trades={incoming}
            me={me}
            factionsById={factionsById}
            emptyText="No incoming offers."
            actions={(trade) => (
              <>
                <button
                  className="mp-btn-primary"
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
        )}
        {tab === 'outgoing' && (
          <TradeList
            trades={outgoing}
            me={me}
            factionsById={factionsById}
            emptyText="No outgoing offers."
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
        )}
        {tab === 'pacts' && (
          <PactsList pacts={pacts} factionsById={factionsById} />
        )}
        {tab === 'history' && (
          <TradeList
            trades={history}
            me={me}
            factionsById={factionsById}
            emptyText="No resolved trades yet."
            showStatus
          />
        )}
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

function TabButton({
  active, count, onClick, children,
}: {
  active: boolean;
  count?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`mp-tab ${active ? 'active' : ''}`}
      style={{
        flex: 1,
        padding: '6px 8px',
        background: active ? 'rgba(78, 205, 196, 0.2)' : 'transparent',
        border: '1px solid ' + (active ? '#4ecdc4' : '#2a3d50'),
        color: active ? '#4ecdc4' : '#a8b8c8',
        fontFamily: 'inherit',
        fontSize: 10,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        borderRadius: 2,
      }}
    >
      {children}{count != null && count > 0 ? ` (${count})` : ''}
    </button>
  );
}

function TradeList({
  trades, me, factionsById, actions, emptyText, showStatus,
}: {
  trades: TradeOffer[];
  me: MyFaction | null;
  factionsById: Map<string, Faction>;
  actions?: (trade: TradeOffer) => React.ReactNode;
  emptyText: string;
  showStatus?: boolean;
}) {
  if (!trades.length) {
    return <div className="mp-empty" style={{ textAlign: 'center', padding: 16, color: '#b8c8d6' }}>{emptyText}</div>;
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
        />
      ))}
    </div>
  );
}

function TradeCard({
  trade, me, factionsById, actions, showStatus,
}: {
  trade: TradeOffer;
  me: MyFaction | null;
  factionsById: Map<string, Faction>;
  actions?: (trade: TradeOffer) => React.ReactNode;
  showStatus?: boolean;
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
    <div
      style={{
        border: '1px solid #2a3d50',
        background: 'rgba(78, 205, 196, 0.05)',
        borderRadius: 3,
        padding: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center' }}>
        <div style={{ fontSize: 10, color: '#b8c8d6' }}>
          {isMineOutgoing ? 'To' : 'From'}{' '}
          <span style={{ color: otherParty?.color ?? '#d8e4ee', fontWeight: 600 }}>
            {otherParty?.name ?? 'unknown'}
          </span>
        </div>
        {showStatus && (
          <span style={{
            fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: statusColor(trade.status), border: `1px solid ${statusColor(trade.status)}`,
            padding: '1px 6px', borderRadius: 8,
          }}>
            {trade.status}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
        <Side label="You give" bundle={youGive} pacts={youGivePacts} align="left" />
        <div style={{ color: '#b8c8d6', fontSize: 14 }}>⇄</div>
        <Side label="You receive" bundle={theyGive} pacts={theyGivePacts} align="right" />
      </div>

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

      {actions && (
        <div style={{ display: 'flex', gap: 4, marginTop: 8, justifyContent: 'flex-end' }}>
          {actions(trade)}
        </div>
      )}
    </div>
  );
}

function Side({
  label, bundle, pacts, align,
}: {
  label: string;
  bundle: ResourceBundle;
  pacts: PactKind[];
  align: 'left' | 'right';
}) {
  const keys = (Object.keys(bundle) as Array<keyof ResourceBundle>).filter((k) => bundle[k] > 0);
  const empty = keys.length === 0 && pacts.length === 0;
  return (
    <div style={{ textAlign: align }}>
      <div style={{
        fontSize: 8, color: '#b8c8d6', letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 2,
      }}>
        {label}
      </div>
      {empty ? (
        <div style={{ fontSize: 10, color: '#b8c8d6', fontStyle: 'italic' }}>nothing</div>
      ) : (
        <>
          {keys.map((k) => (
            <div key={k} style={{ fontSize: 11, color: RESOURCE_COLORS[k], lineHeight: '14px' }}>
              {bundle[k]} {RESOURCE_LABELS[k]}
            </div>
          ))}
          {pacts.map((p) => (
            <div key={p} style={{ fontSize: 10, color: '#4ecdc4', lineHeight: '14px' }}>
              ✦ {PACT_LABELS[p]}
            </div>
          ))}
        </>
      )}
    </div>
  );
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {pacts.map((p) => (
        <div
          key={p.id}
          style={{
            border: '1px solid #4ecdc4',
            background: 'rgba(78, 205, 196, 0.08)',
            borderRadius: 3,
            padding: 8,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: '#4ecdc4', marginBottom: 4 }}>
            {PACT_LABELS[p.kind]}
          </div>
          <div style={{ fontSize: 10, color: '#a8b8c8' }}>
            with{' '}
            {p.counterparty_faction_ids.map((id, i) => {
              const f = factionsById.get(id);
              return (
                <span key={id} style={{ color: f?.color ?? '#d8e4ee', fontWeight: 500 }}>
                  {f?.name ?? id}{i < p.counterparty_faction_ids.length - 1 ? ', ' : ''}
                </span>
              );
            })}
          </div>
          <div style={{ fontSize: 9, color: '#b8c8d6', marginTop: 2 }}>
            Signed T+{p.signed_at_tick}
            {p.expires_at_tick != null && ` · expires T+${p.expires_at_tick}`}
          </div>
        </div>
      ))}
    </div>
  );
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
