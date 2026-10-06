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
  COMMISSION_FACTS, COMMISSION_NAME, COMMISSION_PRICE, HOLDER_MARK, canBuyHere, logCommission,
} from './commission';
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
    setErr('Could not start checkout. Try again in a minute.');
  };

  const redeem = async () => {
    setRedeeming(true); setRedeemMsg(null);
    const res = await apiFetch<{ ok: boolean }>('/api/commission/redeem', {
      method: 'POST', body: JSON.stringify({ code }),
    });
    setRedeeming(false);
    if (!res.ok) {
      setRedeemMsg(res.error?.message ?? 'That code did not work.');
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
    if (!res.ok) setSkinErr(res.error?.message ?? 'Could not save that style.');
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
      <div className="pp-h" id="hg-title">HANGAR</div>

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
              <span className="hg-mark" aria-hidden>{HOLDER_MARK}</span> You hold the {COMMISSION_NAME}
            </div>
            <p className="hg-body">
              Thank you for supporting Orbital. Your lines and flags are in the ship designer, the lobby flag
              section and every megastructure's look picker, your colony and station styles are just below,
              and the {HOLDER_MARK} beside your name shows other commanders.
            </p>
          </>
        ) : (
          <>
            <div className="hg-title">{COMMISSION_NAME}</div>
            <p className="hg-body">{COMMISSION_FACTS} Orbital is free and stays free; this is how you can support it.</p>
            {sellable ? (
              <button className="pp-btn pp-btn--primary" disabled={busy !== null} onClick={() => void buy(false)}>
                {busy === 'self' ? 'Opening checkout…' : `Get the Commission · ${COMMISSION_PRICE}`}
              </button>
            ) : (
              <p className="hg-offsite">
                The Commission is bought on the Orbital website, not in the app. It unlocks here the next
                time you sign in. <span className="hg-where">{WEBSITE_ORIGIN.replace('https://', '')}</span>
              </p>
            )}
          </>
        )}
        {err && <div className="pp-error hg-err">{err}</div>}
      </div>

      {/* ---- colony & station style ---- */}
      <div className="hg-skins">
        <div className="hg-sub-h">Colony &amp; station style</div>
        <p className="hg-sub">
          How your cities and stations look in every game. Weapons, labs, forges and the rest keep their
          shapes in every style, so rivals still read your strength. You can change it per game in the lobby.
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
          <div className="hg-sub-h">Give it to a friend</div>
          <p className="hg-body">
            Buy a Commission for someone else and you get a code to pass on. It is theirs when they redeem it.
          </p>
          <button className="pp-btn" disabled={busy !== null} onClick={() => void buy(true)}>
            {busy === 'gift' ? 'Opening checkout…' : `Buy a gift · ${COMMISSION_PRICE}`}
          </button>
          {giftJustBought && gifts.length === 0 && (
            <p className="hg-sub">Your code is on its way; it appears here in a few seconds.</p>
          )}
          {gifts.length > 0 && (
            <ul className="hg-gifts">
              {gifts.map(g => (
                <li key={g.code} className={g.voided ? 'is-void' : g.redeemed_at ? 'is-used' : ''}>
                  <code>{g.code}</code>
                  <span className="hg-gift__state">
                    {g.voided ? 'refunded'
                      : g.redeemed_at ? `redeemed${g.redeemed_by_name ? ` by ${g.redeemed_by_name}` : ''}`
                        : 'not yet redeemed'}
                  </span>
                  {!g.voided && !g.redeemed_at && (
                    <button className="pp-btn" onClick={() => void copy(g.code)}>
                      {copied === g.code ? 'Link copied' : 'Copy gift link'}
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
          <div className="hg-sub-h">Have a gift code?</div>
          <div className="hg-redeem__row">
            <input
              className="pp-input"
              value={code}
              placeholder="XXXX-XXXX-XXXX"
              maxLength={20}
              aria-label="Gift code"
              onChange={e => { setCode(e.target.value); setRedeemMsg(null); }}
              onKeyDown={e => { if (e.key === 'Enter' && code.trim()) void redeem(); }}
            />
            <button className="pp-btn pp-btn--primary" disabled={redeeming || !code.trim()} onClick={() => void redeem()}>
              {redeeming ? 'Redeeming…' : 'Redeem'}
            </button>
          </div>
          {redeemMsg && <div className="pp-error hg-err">{redeemMsg}</div>}
        </div>
      )}
    </section>
  );
}
