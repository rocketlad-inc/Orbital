// ============================================================
// AssetDealsSection — selling a hull or a world, inside Trade.
//
// Trade agreements move RESOURCES on a standing lane. This is the other
// kind of deal: one-off, where the thing changing hands is a ship or a
// settled world and the payment is hauled in by freighter. It is a
// deal, so it belongs with the deals.
//
// It takes everything as props and touches no game state. That is the
// whole point: an earlier cut of this lived in the economy tab purely
// because TradesPanel mounts outside GameContextProvider and had no
// ships or settlements to offer. Letting a React tree decide where a
// feature lives is how a menu ends up unintuitive, so the server grew a
// panel-shaped listing endpoint instead and the feature came home.
// ============================================================

import React, { useState } from 'react';
import type { AssetDealsView, AssetSellable } from './api';
import type { Faction } from './api';

interface Props {
  view: AssetDealsView | null;
  factions: Faction[];
  callerFactionId: string | null;
  busy: boolean;
  onPropose: (input: {
    assetKind: 'ship' | 'settlement';
    assetId: string;
    buyerFactionId: string;
    priceMetal: number;
    priceCredits: number;
  }) => Promise<boolean>;
  onRespond: (dealId: string, accept: boolean) => Promise<boolean>;
  onPay: (dealId: string, shipId: string) => Promise<boolean>;
  onCancel: (dealId: string) => Promise<boolean>;
}

const refOf = (s: AssetSellable) => `${s.kind}:${s.id}`;

export const AssetDealsSection: React.FC<Props> = ({
  view, factions, callerFactionId, busy,
  onPropose, onRespond, onPay, onCancel,
}) => {
  const [composing, setComposing] = useState(false);
  const [assetRef, setAssetRef] = useState('');
  const [buyerId, setBuyerId] = useState('');
  const [priceMetal, setPriceMetal] = useState('0');
  const [priceCredits, setPriceCredits] = useState('0');
  const [localError, setLocalError] = useState<string | null>(null);

  const deals = view?.deals ?? [];
  const sellable = view?.sellable ?? [];
  const freighters = view?.freighters ?? [];
  const buyers = factions.filter(f => f.id !== callerFactionId);

  const priceOf = (d: { price_metal: number; price_credits: number }) => {
    const parts: string[] = [];
    if (d.price_metal > 0) parts.push(`${d.price_metal} metal`);
    if (d.price_credits > 0) parts.push(`${d.price_credits} credits`);
    return parts.join(' + ') || 'nothing';
  };

  const paidOf = (d: {
    price_metal: number; price_credits: number;
    paid_metal: number; paid_credits: number;
  }) => {
    const parts: string[] = [];
    if (d.price_metal > 0) parts.push(`${d.paid_metal}/${d.price_metal} metal`);
    if (d.price_credits > 0) parts.push(`${d.paid_credits}/${d.price_credits} credits`);
    return parts.join(' · ');
  };

  const submit = async () => {
    const sep = assetRef.indexOf(':');
    const kind = sep < 0 ? '' : assetRef.slice(0, sep);
    const assetId = sep < 0 ? '' : assetRef.slice(sep + 1);
    if (kind !== 'ship' && kind !== 'settlement') {
      setLocalError('Pick something to sell.');
      return;
    }
    if (!buyerId) { setLocalError('Pick who you are selling to.'); return; }
    const m = Math.max(0, Math.floor(Number(priceMetal) || 0));
    const c = Math.max(0, Math.floor(Number(priceCredits) || 0));
    if (m <= 0 && c <= 0) {
      setLocalError('Name a price — a free handover is a gift, not a deal.');
      return;
    }
    setLocalError(null);
    const ok = await onPropose({
      assetKind: kind, assetId, buyerFactionId: buyerId,
      priceMetal: m, priceCredits: c,
    });
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
          onClick={() => { setComposing(v => !v); setLocalError(null); }}
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

      {localError && <div className="adc__err">{localError}</div>}

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
                <option key={refOf(s)} value={refOf(s)}>
                  {s.label}{s.where ? ` — ${s.where}` : ''}
                </option>
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

      {view === null && <div className="adc__empty">Loading sales…</div>}
      {view !== null && deals.length === 0 && !composing && (
        <div className="adc__empty">No sales on the table.</div>
      )}

      {deals.map(d => (
        <div key={d.id} className="adc__deal">
          <div className="adc__dealhead">
            {d.i_am_seller ? 'Selling ' : 'Buying '}
            <strong>{d.asset_name}</strong>
            {d.asset_detail ? ` (${d.asset_detail})` : ''}
            {d.i_am_seller ? ' to ' : ' from '}
            <strong>{d.i_am_seller ? d.buyer_name : d.seller_name}</strong>
          </div>
          <div className="adc__dealsub">
            {priceOf(d)}
            {d.status === 'active' && <> · paid {paidOf(d)}</>}
            {d.delivery_body_name && <> · to {d.delivery_body_name}</>}
            {d.status === 'offered' && <> · awaiting an answer</>}
          </div>
          <div className="adc__acts">
            {!d.i_am_seller && d.status === 'offered' && (
              <>
                <button
                  className="adc__btn"
                  disabled={busy}
                  onClick={() => onRespond(d.id, true)}
                >
                  Accept
                </button>
                <button
                  className="adc__btn adc__btn--warn"
                  disabled={busy}
                  onClick={() => onRespond(d.id, false)}
                >
                  Decline
                </button>
              </>
            )}

            {!d.i_am_seller && d.status === 'active' && (
              freighters.length > 0 ? (
                <select
                  className="adc__select"
                  defaultValue=""
                  disabled={busy}
                  onChange={e => {
                    const shipId = e.target.value;
                    e.currentTarget.value = '';
                    if (shipId) onPay(d.id, shipId);
                  }}
                >
                  <option value="">Send a freighter…</option>
                  {freighters.map(f => (
                    <option key={f.id} value={f.id}>
                      {f.name}{f.where ? ` — ${f.where}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="adc__note">
                  No idle freighter to carry the payment.
                </span>
              )
            )}

            <button
              className="adc__btn adc__btn--warn"
              disabled={busy}
              onClick={() => onCancel(d.id)}
            >
              {d.i_am_seller ? 'Withdraw' : 'Back out'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
