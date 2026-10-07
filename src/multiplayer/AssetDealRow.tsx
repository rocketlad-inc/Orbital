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
//
// PAYING (fartmaster, 2026-10-06: "Trading for a planet does not seem to
// work"). "Send a freighter" used to call the unload endpoint, which
// only took a hull already parked at the asset with the payment aboard.
// It now SENDS: the freighter loads at your dock and hauls the payment
// to the place picked here -- the asset, or any of the seller's
// settlements (worker/assetDeals.js, PAYING BY FREIGHTER).
// ============================================================

import React, { useState } from 'react';
import type { AssetDealRow as AssetDealRowData } from './api';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';

interface Props {
  deal: AssetDealRowData;
  freighters: Array<{ id: string; name: string; where: string | null }>;
  busy: boolean;
  onRespond: (dealId: string, accept: boolean) => Promise<boolean>;
  onPay: (dealId: string, shipId: string, destBodyId?: string) => Promise<boolean>;
  onCancel: (dealId: string) => Promise<boolean>;
}

const priceOf = (d: AssetDealRowData) => {
  const parts: string[] = [];
  if (d.price_metal > 0) parts.push(t('trade.deal.metalAmt', { n: d.price_metal }));
  if (d.price_credits > 0) parts.push(t('trade.deal.creditsAmt', { n: d.price_credits }));
  return parts.join(' + ') || t('trade.deal.nothing');
};

const paidOf = (d: AssetDealRowData) => {
  const parts: string[] = [];
  if (d.price_metal > 0) parts.push(t('trade.deal.paidMetal', { paid: d.paid_metal, price: d.price_metal }));
  if (d.price_credits > 0) parts.push(t('trade.deal.paidCredits', { paid: d.paid_credits, price: d.price_credits }));
  return parts.join(' · ');
};

/** The pay-at picker: the asset first, then the seller's other worlds. */
const PayControls: React.FC<{
  d: AssetDealRowData;
  freighters: Props['freighters'];
  busy: boolean;
  onPay: Props['onPay'];
}> = ({ d, freighters, busy, onPay }) => {
  useI18n();
  const dests = d.pay_dests ?? [];
  const [dest, setDest] = useState<string>(d.delivery_body_id ?? dests[0]?.body_id ?? '');
  const coming = d.in_flight ?? { metal: 0, credits: 0, freighters: 0 };
  const owedM = Math.max(0, d.price_metal - d.paid_metal - coming.metal);
  const owedC = Math.max(0, d.price_credits - d.paid_credits - coming.credits);
  const covered = owedM + owedC <= 0;
  return (
    <>
      {coming.freighters > 0 && (
        <span className="adc__note">
          {tn('trade.deal.freightersOnWay', coming.freighters)}
          {' '}({[coming.metal > 0 ? t('trade.deal.metalAmt', { n: coming.metal }) : '', coming.credits > 0 ? t('trade.deal.creditsAmt', { n: coming.credits }) : '']
            .filter(Boolean).join(' + ')})
        </span>
      )}
      {covered ? null : freighters.length === 0 ? (
        <span className="adc__note">{t('trade.deal.noFreighter')}</span>
      ) : (
        <>
          {dests.length > 1 && (
            <select
              className="adc__select"
              value={dest}
              disabled={busy}
              onChange={e => setDest(e.target.value)}
              title={t('trade.deal.payAtTip')}
            >
              {dests.map(x => (
                <option key={x.body_id} value={x.body_id}>
                  {t('trade.deal.payAt', { name: x.name })}{x.body_id === d.delivery_body_id ? ` (${t('trade.deal.theAsset')})` : ''}
                </option>
              ))}
            </select>
          )}
          <select
            className="adc__select"
            defaultValue=""
            disabled={busy}
            title={t('trade.deal.sendTip')}
            onChange={e => {
              const shipId = e.target.value;
              e.currentTarget.value = '';
              if (shipId) onPay(d.id, shipId, dest || undefined);
            }}
          >
            <option value="">{t('trade.deal.sendFreighter')}</option>
            {freighters.map(f => (
              <option key={f.id} value={f.id}>
                {f.name}{f.where ? ` — ${f.where}` : ''}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
};

export const AssetDealRow: React.FC<Props> = ({
  deal: d, freighters, busy, onRespond, onPay, onCancel,
}) => {
  useI18n();
  return (
  <div className="adc__deal">
    <div className="adc__dealhead">
      {d.i_am_seller ? t('trade.deal.selling') : t('trade.deal.buying')}{' '}
      <strong>{d.asset_name}</strong>
      {d.asset_detail ? ` (${d.asset_detail})` : ''}
      {' '}{d.open_listing ? t('trade.deal.on') : d.i_am_seller ? t('trade.deal.to') : t('trade.deal.from')}{' '}
      <strong>{d.i_am_seller ? d.buyer_name : d.seller_name}</strong>
    </div>
    <div className="adc__dealsub">
      {priceOf(d)}
      {d.status === 'active' && <> · {t('trade.deal.paid', { paid: paidOf(d) })}</>}
      {d.delivery_body_name && <> · {t('trade.deal.toBody', { name: d.delivery_body_name })}</>}
      {d.status === 'offered' && (
        <> · {d.open_listing
          ? t('trade.deal.unclaimed')
          : d.i_am_seller ? t('trade.deal.awaitingTheirs') : t('trade.deal.awaitingYours')}</>
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
            {t('trade.deal.accept')}
          </button>
          <button
            className="adc__btn adc__btn--warn"
            disabled={busy}
            onClick={() => onRespond(d.id, false)}
          >
            {t('trade.deal.decline')}
          </button>
        </>
      )}

      {/* Paying is the buyer's job and takes as many runs as the price
          needs, so the control stays on the row until it is settled. */}
      {!d.i_am_seller && d.status === 'active' && (
        <PayControls d={d} freighters={freighters} busy={busy} onPay={onPay} />
      )}

      <button
        className="adc__btn adc__btn--warn"
        disabled={busy}
        onClick={() => onCancel(d.id)}
      >
        {d.i_am_seller ? t('trade.deal.withdraw') : t('trade.deal.backOut')}
      </button>
    </div>
  </div>
  );
};
