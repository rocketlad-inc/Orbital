// ============================================================
// CommissionFleetPreview — the Commission's look on EVERY hull you fly,
// in your empire's colours (Shipwright, 2026-10-08). Opened from the
// designer's offer while a Commission look is on the ship: one line, the
// whole fleet, and the other lines a tap away. Sells only where the
// client can sell (canBuyHere); in the Android app the same buttons open
// the website in the phone's browser. Previewing is fine everywhere.
// ============================================================

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShipIcon, ICON_VARIANT_NAMES, PREMIUM_VARIANTS, ALL_VARIANTS } from './ShipIcons';
import type { ShipIconVariant } from './ShipIcons';
import { SHIP_CLASSES } from '../game/shipClasses';
import {
  COMMISSION_NAME, COMMISSION_PRICE, COMMISSION_DISCORD, COMMISSION_NO_GAMEPLAY, COMMISSION_LINES,
  COMMISSION_EMBLEMS, COMMISSION_CITY_SKINS, COMMISSION_STATION_SKINS, COMMISSION_STRUCTURE_LOOKS,
  canBuyHere, logCommission, openCommissionInBrowser,
} from '../multiplayer/commission';
import { startCommissionCheckout } from '../multiplayer/api';
import { t, tk } from '../i18n/core';

const FLEET = [
  ['colony', 76], ['freighter', 84], ['corvette', 76], ['frigate', 108], ['destroyer', 156],
] as const;

interface Props {
  initialLine: ShipIconVariant;
  p1: string;
  p2: string;
  onClose: () => void;
}

export const CommissionFleetPreview: React.FC<Props> = ({ initialLine, p1, p2, onClose }) => {
  const [line, setLine] = useState<ShipIconVariant>(initialLine);
  // Esc is the designer's: it closes this first (ShipDesigner).
  useEffect(() => { logCommission('designer', 'view'); }, []);
  const lines = ALL_VARIANTS.filter(v => PREMIUM_VARIANTS.has(v));
  const sellable = canBuyHere();
  const buy = (gift: boolean) => {
    logCommission('designer', 'click');
    void startCommissionCheckout('designer', { gift }).then(url => { if (url) window.location.assign(url); });
  };
  const facts = tk('mp.commission.facts', '', {
    lines: COMMISSION_LINES, emblems: COMMISSION_EMBLEMS, city: COMMISSION_CITY_SKINS,
    station: COMMISSION_STATION_SKINS, looks: COMMISSION_STRUCTURE_LOOKS,
    discord: tk('mp.commission.discord', COMMISSION_DISCORD),
    noGameplay: tk('mp.commission.noGameplay', COMMISSION_NO_GAMEPLAY),
    price: tk('mp.commission.price', COMMISSION_PRICE),
  });

  return createPortal(
    <div className="cfp-scrim" onClick={onClose}>
      <div className="cfp" role="dialog" aria-modal="true" aria-labelledby="cfp-title" onClick={e => e.stopPropagation()} data-testid="commission-fleet-preview">
        <div className="cfp__main">
          <div className="cfp__head">
            <span className="cfp__kicker">{tk('mp.commission.name', COMMISSION_NAME)}</span>
            <h2 id="cfp-title" className="cfp__title">{t('ship.sd.cfp.title', { line: (ICON_VARIANT_NAMES.destroyer[line] ?? '').toUpperCase() })}</h2>
            <span className="cfp__sub">{t('ship.sd.cfp.sub')}</span>
          </div>
          <div className="cfp__stage">
            <div className="cfp__ring" aria-hidden />
            {FLEET.map(([cls, size]) => (
              <div key={cls} className="cfp__hull">
                <ShipIcon shipClass={cls} variant={line} size={size} color={p1} color2={p2} />
                <span>{SHIP_CLASSES[cls].displayName}</span>
              </div>
            ))}
          </div>
          <div className="cfp__lines">
            <span className="cfp__kicker">{t('ship.sd.cfp.try')}</span>
            <div className="cfp__chips">
              {lines.map(v => (
                <button key={v} type="button" aria-pressed={v === line} className={`cfp__chip ${v === line ? 'is-on' : ''}`} onClick={() => setLine(v)}>
                  {ICON_VARIANT_NAMES.destroyer[v]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="cfp__side">
          <div className="cfp__sidehead">
            <span className="cfp__name">{HOLDER}{' '}{tk('mp.commission.name', COMMISSION_NAME).toUpperCase()}</span>
            <button type="button" className="cfp__x" onClick={onClose} aria-label={t('ship.sd.close')}>×</button>
          </div>
          <span className="cfp__price">{tk('mp.commission.price', COMMISSION_PRICE)}</span>
          <span className="cfp__facts">{facts}</span>
          <span className="cfp__fill" />
          {sellable && (
            <>
              <button type="button" className="cfp__get" onClick={() => buy(false)}>
                {tk('mp.commission.get', 'Get the Commission · {price}', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
              </button>
              <button type="button" className="cfp__quiet" onClick={() => buy(true)}>{t('ship.sd.cfp.gift')}</button>
            </>
          )}
          {!sellable && (
            <>
              <button type="button" className="cfp__get" onClick={() => openCommissionInBrowser('designer')}>
                {t('mp.commission.inBrowser', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
              </button>
              <button type="button" className="cfp__quiet" onClick={() => openCommissionInBrowser('designer', { gift: true })}>
                {t('mp.commission.giftInBrowser')}
              </button>
            </>
          )}
          <button type="button" className="cfp__quiet" onClick={onClose}>{t('ship.sd.cfp.close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const HOLDER = '❖';
