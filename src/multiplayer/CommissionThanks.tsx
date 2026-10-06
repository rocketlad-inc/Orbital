// ============================================================
// CommissionThanks — the moment after someone pays.
//
// Stripe's hosted page hands the player back at /?purchase=success, and
// until now that landed them in the game with a single line of text in a
// panel they might not even have open. Someone had just given us ten
// dollars and the game barely acknowledged it.
//
// So: a full-screen confirmation that does three jobs, in the order the
// player actually wants them.
//
//   1. It worked. Said first, said plainly.
//   2. Here is what you bought — rendered, not described. The Commission
//      unlocks ten ship silhouettes and ten emblems, and they are drawn
//      here from the same components the game draws them with, so this
//      is the real thing rather than a picture of it.
//   3. Where to go and use it.
//
// THE UNLOCK IS ASYNCHRONOUS, AND THAT IS THE INTERESTING PART. Stripe
// redirects the browser the instant the card clears, but the entitlement
// arrives separately, on the webhook, a beat later. So this opens in a
// WAITING state with the goods dimmed and locked, and lights them up the
// moment `is_premium` flips. The player watches the thing they bought
// arrive. That beat is free — we were going to spend it waiting either
// way — and it turns the weakest part of the flow into the best one.
//
// If the webhook is slow or lost, the wait degrades into an honest
// message rather than spinning forever at someone who has paid.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { ShipIcon, PREMIUM_VARIANTS } from '../components/ShipIcons';
import { FactionEmblem } from '../components/FactionEmblem';
import { PREMIUM_EMBLEM_IDS, EMBLEM_NAMES } from '../game/emblems';
import './CommissionThanks.css';

/** How long to wait for the webhook before saying so out loud. The grant
 *  is normally in hand within a second or two; past this it is worth
 *  telling the player the truth instead of animating at them. */
const PATIENCE_MS = 20000;

/** Spread the ten variants across hull shapes so the wall reads as a
 *  fleet rather than ten copies of one silhouette. */
const HULLS = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'] as const;

export function CommissionThanks({
  unlocked,
  onClose,
}: {
  /** Mirrors auth user.is_premium — flips when the webhook lands. */
  unlocked: boolean;
  onClose: () => void;
}) {
  const [waitedTooLong, setWaitedTooLong] = useState(false);

  useEffect(() => {
    if (unlocked) return undefined;
    const t = setTimeout(() => setWaitedTooLong(true), PATIENCE_MS);
    return () => clearTimeout(t);
  }, [unlocked]);

  // Esc closes, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const icons = useMemo(
    () => [...PREMIUM_VARIANTS].map((variant, i) => ({ variant, hull: HULLS[i % HULLS.length] })),
    [],
  );

  return (
    <div className="mp-thanks-scrim" role="dialog" aria-modal="true" aria-label="Commission confirmed">
      <div className={`mp-thanks${unlocked ? ' is-unlocked' : ''}`}>
        <button type="button" className="mp-thanks-x" onClick={onClose} aria-label="Close">×</button>

        <p className="mp-thanks-eyebrow">Payment complete</p>
        <h2 className="mp-thanks-title">The Commission is yours</h2>
        <p className="mp-thanks-sub">
          Thank you — genuinely. Orbital is made by one person, and this is what
          keeps it running.
        </p>

        <div className="mp-thanks-status">
          {unlocked ? (
            <span className="mp-thanks-live">★ Unlocked on your account</span>
          ) : waitedTooLong ? (
            <span className="mp-thanks-slow">
              Your payment went through. The unlock is taking longer than usual —
              it will land on your account shortly, and it is safe to close this.
            </span>
          ) : (
            <span className="mp-thanks-wait">
              <i className="mp-thanks-dot" aria-hidden />
              Unlocking your account…
            </span>
          )}
        </div>

        <section className="mp-thanks-goods" aria-busy={!unlocked}>
          <h3>{icons.length} ship lines</h3>
          <div className="mp-thanks-row">
            {icons.map(({ variant, hull }) => (
              <span className="mp-thanks-cell" key={variant} title={`Variant ${variant}`}>
                <ShipIcon shipClass={hull} variant={variant} size={34} color="#4ecdc4" color2="#ffc24a" />
                <b>{variant}</b>
              </span>
            ))}
          </div>

          <h3>{PREMIUM_EMBLEM_IDS.length} flag emblems</h3>
          <div className="mp-thanks-row">
            {PREMIUM_EMBLEM_IDS.map(id => (
              <span className="mp-thanks-cell" key={id} title={EMBLEM_NAMES[id]}>
                <FactionEmblem emblem={id} fallbackKey={id} size={28} color="#ffc24a" />
                <b>{EMBLEM_NAMES[id]}</b>
              </span>
            ))}
          </div>
        </section>

        <p className="mp-thanks-where">
          Put them on any hull in the <strong>ship designer</strong>, and your
          emblem on the <strong>faction</strong> panel. They fly on everything
          you own, and every other empire sees them.
        </p>

        <p className="mp-thanks-where" data-testid="thanks-discord">
          <strong>Your games in your own Discord:</strong> in any game you host,
          open its <strong>Discord game feed</strong> settings and press
          {' '}<strong>Connect your server</strong>. Its wars, battles and the daily
          Herald post straight into your channel.
        </p>

        <button type="button" className="mp-thanks-go" onClick={onClose}>
          Back to the game
        </button>
      </div>
    </div>
  );
}

export default CommissionThanks;
