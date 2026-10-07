// ============================================================
// Hangar — the Commander's Commission, at the top of Profile.
//
// It used to sit at the bottom of the tab, under the email settings,
// with "Support the game, get more icons, get your Commission!". The
// insight report (Oct 5) found nobody could stumble onto it there, and
// the copy undersold the goods (it said ten ship lines; there are
// sixteen). Now it opens the tab, shows the real hulls and flags, and
// says what you get in one plain sentence.
//
// Also the home of GIFTS (0153): a holder can buy the Commission for a
// friend and gets a code to pass on; anyone without it can redeem one.
// In the Android app nothing here sells: the app names the Commission
// and says where it is bought, and buying a gift is web-only too.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, startCommissionCheckout } from './api';
import { useAuth } from './AuthContext';
import { ShipIcon, ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import { FactionEmblem } from '../components/FactionEmblem';
import { PREMIUM_EMBLEM_IDS } from '../game/emblems';
import { WEBSITE_ORIGIN } from '../platform/appShell';
import { SkinPicker, SkinField } from './SkinPicker';
import {
  COMMISSION_FACTS, COMMISSION_PRICE, HOLDER_MARK, canBuyHere, logCommission,
  COMMISSION_DISCORD_DETAIL,
} from './commission';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';
import './Hangar.css';

/** The goods, drawn: one premium line on each hull class. */
const SHOWCASE: Array<[ShipIconClass, ShipIconVariant]> = [
  ['destroyer', 'S'], ['frigate', 'R'], ['corvette', 'J'],
  ['freighter', 'V'], ['colony', 'X'], ['destroyer', 'Y'],
];

type Gift = {
  code: string; created_at: number; redeemed_at: number | null;
  redeemed_by_name: string | null; voided: boolean;
};

/** A gift link: opens Orbital with the code filled in, ready to redeem. */
export const PENDING_GIFT_KEY = 'orbital.pendingGift';
const giftLink = (code: string) => `${WEBSITE_ORIGIN}/?gift=${code}`;

export function Hangar({ onRedeemed, giftJustBought }: {
  /** A gift was redeemed on this account: the panel shows its thank-you. */
  onRedeemed: () => void;
  /** Back from a gift checkout: watch for the code to land. */
  giftJustBought: boolean;
}) {
  useI18n();
  const { user, refresh } = useAuth();
  const holder = !!user?.is_premium;
  const sellable = canBuyHere();
  const [busy, setBusy] = useState<'self' | 'gift' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gifts, setGifts] = useState<Gift[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<string | null>(null);

  // A view, once per page load, only for people it could sell to.
  useEffect(() => { if (!holder) logCommission('profile', 'view'); }, [holder]);
  // A holder has no use for a pending code; forget it so the lobby stops
  // opening on Profile for it.
  useEffect(() => {
    if (holder) { try { localStorage.removeItem(PENDING_GIFT_KEY); } catch { /* fine */ } }
  }, [holder]);

  // A code from a gift link (?gift=..., kept across signup in storage).
  useEffect(() => {
    let pending: string | null = null;
    try { pending = new URLSearchParams(window.location.search).get('gift') ?? localStorage.getItem(PENDING_GIFT_KEY); } catch { /* storage blocked */ }
    if (pending) setCode(pending);
    // Strip it from the address bar: a reload or a shared screenshot
    // should not carry someone's unredeemed code around.
    const q = new URLSearchParams(window.location.search);
    if (q.has('gift')) {
      q.delete('gift');
      const rest = q.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    }
  }, []);

  const loadGifts = useCallback(async () => {
    const res = await apiFetch<{ gifts: Gift[] }>('/api/commission/gifts');
    if (res.ok) setGifts(res.data.gifts);
    return res.ok ? res.data.gifts.length : 0;
  }, []);
  useEffect(() => { void loadGifts(); }, [loadGifts]);

  // The webhook mints the code a beat after Stripe redirects back; poll
  // briefly rather than make the buyer reload to find it.
  useEffect(() => {
    if (!giftJustBought) return;
    let tries = 0;
    const start = gifts.length;
    const iv = setInterval(async () => {
      tries += 1;
      const n = await loadGifts();
      if (n > start || tries >= 10) clearInterval(iv);
    }, 2000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giftJustBought]);

  const buy = async (gift: boolean) => {
    setBusy(gift ? 'gift' : 'self'); setErr(null);
    logCommission('profile', 'click');
    const url = await startCommissionCheckout('profile', { gift });
    if (url) { window.location.assign(url); return; }
    setBusy(null);
    setErr(t('hangar.err.checkout'));
  };

  const redeem = async () => {
    setRedeeming(true); setRedeemMsg(null);
    const res = await apiFetch<{ ok: boolean }>('/api/commission/redeem', {
      method: 'POST', body: JSON.stringify({ code }),
    });
    setRedeeming(false);
    if (!res.ok) {
      setRedeemMsg(apiErrorText(res.error, 'hangar.err.redeem'));
      // A code that can never work again is not "pending" any more.
      if (res.error?.code === 'no_such_gift' || res.error?.code === 'already_redeemed' || res.error?.code === 'bad_code') {
        try { localStorage.removeItem(PENDING_GIFT_KEY); } catch { /* fine */ }
      }
      return;
    }
    try { localStorage.removeItem(PENDING_GIFT_KEY); } catch { /* fine */ }
    setCode('');
    await refresh();
    onRedeemed();
  };

  // Colony / station style, the account default (0154). Optimistic:
  // the tile lights at once and falls back if the server refuses.
  const [skinDraft, setSkinDraft] = useState<{ city_skin?: string | null; station_skin?: string | null }>({});
  const [skinBusy, setSkinBusy] = useState(false);
  const [skinErr, setSkinErr] = useState<string | null>(null);
  const pickSkin = async (field: SkinField, value: string | null) => {
    setSkinErr(null); setSkinBusy(true);
    setSkinDraft(d => ({ ...d, [field]: value }));
    const res = await apiFetch('/api/users/me/skins', { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
    if (!res.ok) setSkinErr(apiErrorText(res.error, 'hangar.err.skin'));
    await refresh();
    setSkinDraft({});
    setSkinBusy(false);
  };
  const citySkin = skinDraft.city_skin !== undefined ? skinDraft.city_skin : (user?.city_skin ?? null);
  const stationSkin = skinDraft.station_skin !== undefined ? skinDraft.station_skin : (user?.station_skin ?? null);

  const copy = async (c: string) => {
    try { await navigator.clipboard.writeText(giftLink(c)); setCopied(c); } catch { setCopied(null); }
  };

  return (
    <section className="pp-section hg" aria-labelledby="hg-title">
      <div className="pp-h" id="hg-title">{t('hangar.title')}</div>

      <div className={`hg-card${holder ? ' is-holder' : ''}`}>
        <div className="hg-goods" aria-hidden>
          {SHOWCASE.map(([cls, v], i) => (
            <ShipIcon key={`${cls}${v}${i}`} shipClass={cls} variant={v} size={30} />
          ))}
          <span className="hg-sep" />
          {PREMIUM_EMBLEM_IDS.slice(0, 5).map(id => (
            <FactionEmblem key={id} emblem={id} fallbackKey={id} size={20} />
          ))}
        </div>

        {holder ? (
          <>
            <div className="hg-title">
              <span className="hg-mark" aria-hidden>{HOLDER_MARK}</span> {t('hangar.youHold', { name: t('hangar.commissionName') })}
            </div>
            <p className="hg-body">
              {t('hangar.holderBody', { mark: HOLDER_MARK })}
            </p>
            <p className="hg-perk" data-testid="hangar-discord">
              <b>{t('hangar.perk.title')}</b> {t('hangar.perk.hostPre')}{' '}
              <b>{t('feed.connect')}</b>.
            </p>
          </>
        ) : (
          <>
            <div className="hg-title">{t('hangar.commissionName')}</div>
            <p className="hg-body">{COMMISSION_FACTS} {t('hangar.free')}</p>
            <p className="hg-perk" data-testid="hangar-discord">
              <b>{t('hangar.perk.title')}</b> {COMMISSION_DISCORD_DETAIL}
            </p>
            {sellable ? (
              <button className="pp-btn pp-btn--primary" disabled={busy !== null} onClick={() => void buy(false)}>
                {busy === 'self' ? t('hangar.opening') : t('feed.buy', { price: COMMISSION_PRICE })}
              </button>
            ) : (
              <p className="hg-offsite">
                {t('hangar.offsite')}{' '}
                <span className="hg-where">{WEBSITE_ORIGIN.replace('https://', '')}</span>
              </p>
            )}
          </>
        )}
        {err && <div className="pp-error hg-err">{err}</div>}
      </div>

      {/* ---- colony & station style ---- */}
      <div className="hg-skins">
        <div className="hg-sub-h">{t('hangar.skins.title')}</div>
        <p className="hg-sub">
          {t('hangar.skins.body')}
        </p>
        <SkinPicker
          city={citySkin}
          station={stationSkin}
          holder={holder}
          surface="skins"
          busy={skinBusy}
          onPick={(f, v) => void pickSkin(f, v)}
        />
        {skinErr && <div className="pp-error hg-err">{skinErr}</div>}
      </div>

      {/* ---- gifts ---- */}
      {sellable && (
        <div className="hg-gift">
          <div className="hg-sub-h">{t('hangar.gift.title')}</div>
          <p className="hg-body">
            {t('hangar.gift.body')}
          </p>
          <button className="pp-btn" disabled={busy !== null} onClick={() => void buy(true)}>
            {busy === 'gift' ? t('hangar.opening') : t('hangar.gift.buy', { price: COMMISSION_PRICE })}
          </button>
          {giftJustBought && gifts.length === 0 && (
            <p className="hg-sub">{t('hangar.gift.coming')}</p>
          )}
          {gifts.length > 0 && (
            <ul className="hg-gifts">
              {gifts.map(g => (
                <li key={g.code} className={g.voided ? 'is-void' : g.redeemed_at ? 'is-used' : ''}>
                  <code>{g.code}</code>
                  <span className="hg-gift__state">
                    {g.voided ? t('hangar.gift.refunded')
                      : g.redeemed_at ? (g.redeemed_by_name ? t('hangar.gift.redeemedBy', { name: g.redeemed_by_name }) : t('hangar.gift.redeemed'))
                        : t('hangar.gift.pending')}
                  </span>
                  {!g.voided && !g.redeemed_at && (
                    <button className="pp-btn" onClick={() => void copy(g.code)}>
                      {copied === g.code ? t('hangar.gift.copied') : t('hangar.gift.copy')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---- redeem ---- (website only: in the app the Commission is
          named, never bought or redeemed; it simply arrives on the
          account once redeemed on the web) */}
      {!holder && sellable && (
        <div className="hg-redeem">
          <div className="hg-sub-h">{t('hangar.redeem.title')}</div>
          <div className="hg-redeem__row">
            <input
              className="pp-input"
              value={code}
              placeholder="XXXX-XXXX-XXXX"
              maxLength={20}
              aria-label={t('hangar.redeem.aria')}
              onChange={e => { setCode(e.target.value); setRedeemMsg(null); }}
              onKeyDown={e => { if (e.key === 'Enter' && code.trim()) void redeem(); }}
            />
            <button className="pp-btn pp-btn--primary" disabled={redeeming || !code.trim()} onClick={() => void redeem()}>
              {redeeming ? t('hangar.redeeming') : t('hangar.redeem')}
            </button>
          </div>
          {redeemMsg && <div className="pp-error hg-err">{redeemMsg}</div>}
        </div>
      )}
    </section>
  );
}
