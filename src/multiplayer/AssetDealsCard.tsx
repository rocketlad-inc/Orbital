// ============================================================
// AssetDealsCard — selling a hull or a world.
//
// Trade agreements move RESOURCES on a standing lane. This is the other
// kind of deal: one-off, where the thing changing hands is a ship or a
// settled world and the payment is hauled in by freighter.
//
// The server has done all of this since migration 0114 — four
// endpoints, its own module, tick-side delivery — and no client ever
// called any of it. Zero rows in every live game. This is the control
// that was missing.
//
// It lives inside GameContextProvider on purpose: the composer needs
// your ships and settlements to offer, and paying needs a freighter to
// send. TradesPanel mounts OUTSIDE that provider and has none of them,
// which is why the obvious home was the wrong one.
// ============================================================

import React, { useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { humanizeMpError } from './errorMessages';
import type { AssetDeal } from '../types';
import './AssetDealsCard.css';

const PLAYER = 'player';

export const AssetDealsCard: React.FC = () => {
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [assetRef, setAssetRef] = useState('');
  const [buyerId, setBuyerId] = useState('');
  const [priceMetal, setPriceMetal] = useState('0');
  const [priceCredits, setPriceCredits] = useState('0');

  const deals = gameState.assetDeals ?? [];
  const nameOfBody = (id: string | null) =>
    (id && gameState.bodies.find(b => b.id === id)?.name) || null;

  // Deal rows arrive with the caller's own faction already rewritten to
  // 'player' — the same rwFid() pass every other mapping uses — so a
  // side is "mine" by the ordinary comparison. A RIVAL's id is its raw
  // server id, which is also what the propose endpoint wants back.
  const isMine = (factionId: string) => factionId === PLAYER;

  const factionName = (id: string) =>
    gameState.factions.find(x => x.id === id)?.name ?? 'another faction';

  // What you could put up: hulls you own and are not flying, and
  // settlements you hold. The server re-checks all of it at proposal AND
  // again at handover, so this list is a convenience, not the gate.
  const sellable = useMemo(() => {
    const out: Array<{ ref: string; label: string }> = [];
    for (const s of gameState.ships) {
      if (s.ownedBy !== PLAYER || s.transit) continue;
      out.push({ ref: `ship:${s.id}`, label: `${s.name} (${s.class})` });
    }
    for (const st of gameState.settlements) {
      if (st.ownedBy !== PLAYER) continue;
      const where = nameOfBody(st.bodyId);
      out.push({
        ref: `settlement:${st.id}`,
        label: `${st.name}${where ? ` — ${where}` : ''}`,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.ships, gameState.settlements, gameState.bodies]);

  const buyers = gameState.factions.filter(f => f.id !== PLAYER);

  // Idle freighters — a payment leg needs a hull that can leave now.
  const freighters = gameState.ships.filter(
    s => s.ownedBy === PLAYER && s.class === 'freighter' && !s.transit,
  );

  // Asset ids keep their game prefix on the server while client ids are
  // stripped, so match on either shape rather than assuming one.
  const sameId = (serverId: string, localId: string) =>
    serverId === localId || serverId.endsWith(`:${localId}`);

  const labelForAsset = (d: AssetDeal) => {
    if (d.assetKind === 'ship') {
      const sh = gameState.ships.find(s => sameId(d.assetId, s.id));
      return sh ? `${sh.name} (${sh.class})` : 'a hull';
    }
    const st = gameState.settlements.find(s => sameId(d.assetId, s.id));
    return st
      ? `${st.name} — ${nameOfBody(st.bodyId) ?? 'somewhere'}`
      : 'a world';
  };

  const priceOf = (d: AssetDeal) => {
    const parts: string[] = [];
    if (d.priceMetal > 0) parts.push(`${d.priceMetal} metal`);
    if (d.priceCredits > 0) parts.push(`${d.priceCredits} credits`);
    return parts.join(' + ') || 'nothing';
  };

  const paidOf = (d: AssetDeal) => {
    const parts: string[] = [];
    if (d.priceMetal > 0) parts.push(`${d.paidMetal}/${d.priceMetal} metal`);
    if (d.priceCredits > 0) parts.push(`${d.paidCredits}/${d.priceCredits} credits`);
    return parts.join(' · ');
  };

  const run = async (
    fn: () => Promise<{ ok: boolean; code?: string; error?: string }>,
  ) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(humanizeMpError(res.code, res.error ?? 'That did not go through.', 'transfer'));
      }
      return res.ok;
    } finally {
      setBusy(false);
    }
  };

  if (!mpActions) return null;

  const submit = async () => {
    const sep = assetRef.indexOf(':');
    const kind = sep < 0 ? '' : assetRef.slice(0, sep);
    const assetId = sep < 0 ? '' : assetRef.slice(sep + 1);
    if (kind !== 'ship' && kind !== 'settlement') {
      setError('Pick something to sell.');
      return;
    }
    if (!buyerId) { setError('Pick who you are selling to.'); return; }
    const m = Math.max(0, Math.floor(Number(priceMetal) || 0));
    const c = Math.max(0, Math.floor(Number(priceCredits) || 0));
    if (m <= 0 && c <= 0) {
      setError('Name a price — a free handover is a gift, not a deal.');
      return;
    }
    const ok = await run(() => mpActions.proposeAssetDeal({
      assetKind: kind,
      assetId,
      buyerFactionId: buyerId,
      priceMetal: m,
      priceCredits: c,
    }));
    if (ok) {
      setComposing(false);
      setAssetRef('');
      setPriceMetal('0');
      setPriceCredits('0');
    }
  };

  return (
    <div className="adc">
      <div className="adc__head">
        <span className="adc__title">SHIP &amp; WORLD SALES</span>
        <button
          className="adc__btn"
          onClick={() => { setComposing(v => !v); setError(null); }}
          disabled={busy || sellable.length === 0 || buyers.length === 0}
          title={sellable.length === 0
            ? 'Nothing parked that you could hand over'
            : buyers.length === 0
              ? 'Nobody to sell to'
              : 'Offer a hull or a world'}
        >
          {composing ? 'Cancel' : '+ Sell something'}
        </button>
      </div>

      {error && <div className="adc__err">{error}</div>}

      {composing && (
        <div className="adc__compose">
          <label className="adc__row">
            <span className="adc__label">Selling</span>
            <select
              className="adc__select"
              value={assetRef}
              onChange={e => setAssetRef(e.target.value)}
            >
              <option value="">Pick a hull or a world…</option>
              {sellable.map(s => (
                <option key={s.ref} value={s.ref}>{s.label}</option>
              ))}
            </select>
          </label>

          <label className="adc__row">
            <span className="adc__label">To</span>
            <select
              className="adc__select"
              value={buyerId}
              onChange={e => setBuyerId(e.target.value)}
            >
              <option value="">Pick a buyer…</option>
              {buyers.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>

          <div className="adc__row">
            <span className="adc__label">Price</span>
            <span className="adc__price">
              <input
                className="adc__num"
                type="number"
                min={0}
                value={priceMetal}
                onChange={e => setPriceMetal(e.target.value)}
                aria-label="Price in metal"
              />
              <span className="adc__unit">metal</span>
              <input
                className="adc__num"
                type="number"
                min={0}
                value={priceCredits}
                onChange={e => setPriceCredits(e.target.value)}
                aria-label="Price in credits"
              />
              <span className="adc__unit">credits</span>
            </span>
          </div>

          <button className="adc__btn adc__go" onClick={submit} disabled={busy}>
            Offer the sale
          </button>
          <div className="adc__note">
            The buyer hauls the payment to where the asset stands now. It
            changes hands when the last of it arrives.
          </div>
        </div>
      )}

      {deals.length === 0 && !composing && (
        <div className="adc__empty">No sales on the table.</div>
      )}

      {deals.map(d => {
        const iAmSeller = isMine(d.sellerFactionId);
        const other = iAmSeller ? d.buyerFactionId : d.sellerFactionId;
        return (
          <div key={d.id} className="adc__deal">
            <div className="adc__dealhead">
              {iAmSeller ? 'Selling ' : 'Buying '}
              <strong>{labelForAsset(d)}</strong>
              {iAmSeller ? ' to ' : ' from '}
              <strong>{factionName(other)}</strong>
            </div>
            <div className="adc__dealsub">
              {priceOf(d)}
              {d.status === 'active' && <> · paid {paidOf(d)}</>}
              {d.deliveryBodyId && <> · to {nameOfBody(d.deliveryBodyId)}</>}
            </div>
            <div className="adc__acts">
              {!iAmSeller && d.status === 'offered' && (
                <>
                  <button
                    className="adc__btn"
                    disabled={busy}
                    onClick={() => run(() => mpActions.respondAssetDeal(d.id, true))}
                  >
                    Accept
                  </button>
                  <button
                    className="adc__btn adc__btn--warn"
                    disabled={busy}
                    onClick={() => run(() => mpActions.respondAssetDeal(d.id, false))}
                  >
                    Decline
                  </button>
                </>
              )}

              {!iAmSeller && d.status === 'active' && (
                freighters.length > 0 ? (
                  <select
                    className="adc__select"
                    defaultValue=""
                    disabled={busy}
                    onChange={e => {
                      const shipId = e.target.value;
                      e.currentTarget.value = '';
                      if (shipId) run(() => mpActions.payAssetDeal(d.id, shipId));
                    }}
                  >
                    <option value="">Send a freighter…</option>
                    {freighters.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                ) : (
                  <span className="adc__note">
                    No idle freighter to carry the payment.
                  </span>
                )
              )}

              {(d.status === 'offered' || d.status === 'active') && (
                <button
                  className="adc__btn adc__btn--warn"
                  disabled={busy}
                  onClick={() => run(() => mpActions.cancelAssetDeal(d.id))}
                >
                  {iAmSeller ? 'Withdraw' : 'Back out'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
