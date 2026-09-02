// ============================================================
// AssetDealRow — a ship/world sale, as one line in the offers list.
//
// Selling a hull or a world is a one-off deal with its own server
// lifecycle: the buyer hauls the payment to wherever the asset stands,
// and it changes hands when the last of it arrives. None of that is a
// reason to give it its own button, its own section and its own header
// in the trade tab, which is what an earlier cut did — two pipelines
// wearing one tab.
//
// So there is no section here any more. A sale is proposed through the
// ordinary offer composer, and each one renders as a row inside the
// same two lists as every other deal: awaiting your answer if you are
// buying, out on the table if you are selling.
//
// Presentational: data and handlers as props, no game state. That is
// what lets it sit in TradesPanel, which mounts outside the game-state
// provider.
// ============================================================

import React from 'react';
import type { AssetDealRow as AssetDealRowData } from './api';

interface Props {
  deal: AssetDealRowData;
  freighters: Array<{ id: string; name: string; where: string | null }>;
  busy: boolean;
  onRespond: (dealId: string, accept: boolean) => Promise<boolean>;
  onPay: (dealId: string, shipId: string) => Promise<boolean>;
  onCancel: (dealId: string) => Promise<boolean>;
}

const priceOf = (d: AssetDealRowData) => {
  const parts: string[] = [];
  if (d.price_metal > 0) parts.push(`${d.price_metal} metal`);
  if (d.price_credits > 0) parts.push(`${d.price_credits} credits`);
  return parts.join(' + ') || 'nothing';
};

const paidOf = (d: AssetDealRowData) => {
  const parts: string[] = [];
  if (d.price_metal > 0) parts.push(`${d.paid_metal}/${d.price_metal} metal`);
  if (d.price_credits > 0) parts.push(`${d.paid_credits}/${d.price_credits} credits`);
  return parts.join(' · ');
};

export const AssetDealRow: React.FC<Props> = ({
  deal: d, freighters, busy, onRespond, onPay, onCancel,
}) => (
  <div className="adc__deal">
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
      {d.status === 'offered' && (
        <> · {d.i_am_seller ? 'awaiting their answer' : 'awaiting your answer'}</>
      )}
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

      {/* Paying is the buyer's job and takes as many runs as the price
          needs, so the control stays on the row until it is settled. */}
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
);
