// ============================================================
// SkinPicker — colony and station styles (0154), drawn as they appear.
//
// Mounted twice: the Hangar (the account default, used in every game)
// and the lobby's flag section (an override for this one game). Each
// tile is the real renderer, the map's own city and station, in the
// player's colours, so what you pick is what rivals will see.
//
// Premium styles show to everyone, locked, not hidden: a lock you can
// look at is the storefront. Clicking one opens a single calm line
// saying where it comes from (with a buy button on the web, never in
// the Android app). Nothing opens on its own.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { CommissionSurface, startCommissionCheckout } from './api';
import { drawCityArt, stationInnerSvg, STATION_VIEW } from '../render/settlementArt';
import {
  CITY_SKINS, STATION_SKINS, FREE_CITY_SKIN, FREE_STATION_SKIN, SkinDef,
} from '../game/settlementSkins';
import { Settlement } from '../types';
import { deriveSecondary } from '../game/colorUtils';
import {
  COMMISSION_NAME, COMMISSION_PRICE, COMMISSION_DISCORD, COMMISSION_NO_GAMEPLAY, canBuyHere, logCommission,
} from './commission';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './SkinPicker.css';

/** A mid-game colony: every functional building present, so the tile
 *  shows the skin changing the habitats and nothing else. */
const SAMPLE_CITY = {
  population: 7,
  buildings: { forge: 2, mint: 2, lab: 2, trajectory_thrusters: 1 },
} as unknown as Settlement;
const SAMPLE_STATION = { weaponsLevel: 2, labLevel: 1, shipyardLevel: 1, thrustersLevel: 1 };

const TILE_W = 84;
const TILE_H = 70;

function CityTile({ skin, primary, secondary }: { skin: string; primary: string; secondary: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const c = cv?.getContext('2d');
    if (!cv || !c) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = TILE_W * dpr;
    cv.height = TILE_H * dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, TILE_W, TILE_H);
    // City units are ~40 wide around 0,0 with the pad at y=0.
    c.translate(TILE_W / 2, TILE_H * 0.7);
    c.scale(1.6, 1.6);
    drawCityArt(c, SAMPLE_CITY, primary, secondary, skin);
  }, [skin, primary, secondary]);
  return <canvas ref={ref} className="skp-art" aria-hidden />;
}

function StationTile({ skin, primary, secondary }: { skin: string; primary: string; secondary: string }) {
  const v = STATION_VIEW;
  return (
    <svg className="skp-art" viewBox={`${-v} ${-v * 0.83} ${v * 2} ${v * 1.66}`} aria-hidden>
      <g dangerouslySetInnerHTML={{ __html: stationInnerSvg(SAMPLE_STATION, primary, secondary, skin) }} />
    </svg>
  );
}

export type SkinField = 'city_skin' | 'station_skin';

export function SkinPicker({
  city, station, fallbackCity, fallbackStation, primary, secondary, holder, surface, onPick, busy,
}: {
  /** The saved choice; null = none here (the free look, or in a lobby,
   *  the account default). */
  city: string | null;
  station: string | null;
  /** What a null DRAWS as here: the account default in a lobby. */
  fallbackCity?: string | null;
  fallbackStation?: string | null;
  primary?: string | null;
  secondary?: string | null;
  holder: boolean;
  surface: CommissionSurface;
  onPick: (field: SkinField, value: string | null) => void;
  busy?: boolean;
}) {
  useI18n();
  const p = primary || '#4ecdc4';
  const s = secondary || deriveSecondary(p);
  const [lockedPick, setLockedPick] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const sellable = canBuyHere();

  const row = (
    field: SkinField,
    defs: SkinDef<string>[],
    saved: string | null,
    fallback: string | null | undefined,
    free: string,
  ) => {
    // What is drawn now: this choice, else what null falls back to. A
    // premium fallback only draws for a holder (the server says so too).
    const fb = fallback && (holder || fallback === free) ? fallback : free;
    const drawn = saved ?? fb;
    return (
      <div className="skp-row" role="radiogroup" aria-label={field === 'city_skin' ? t('mp.skin.colonyStyle') : t('mp.skin.stationStyle')}>
        {defs.map(d => {
          const locked = !d.free && !holder;
          const on = drawn === d.id;
          return (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={locked || undefined}
              className={`skp-tile${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
              disabled={busy}
              title={locked ? t('mp.skin.lockedTitle', { skin: d.name, name: tk('mp.commission.name', COMMISSION_NAME), blurb: d.blurb }) : `${d.name}. ${d.blurb}`}
              aria-label={d.name}
              onClick={() => {
                if (locked) { setLockedPick(d.name); logCommission(surface, 'view'); return; }
                setLockedPick(null);
                if (on && saved === d.id) return;
                onPick(field, d.id);
              }}
            >
              {field === 'city_skin'
                ? <CityTile skin={d.id} primary={p} secondary={s} />
                : <StationTile skin={d.id} primary={p} secondary={s} />}
              {locked && <span className="skp-lock" aria-hidden>🔒</span>}
              <span className="skp-name">{d.short}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const buy = async () => {
    setOpening(true);
    logCommission(surface, 'click');
    const url = await startCommissionCheckout(surface);
    if (url) { window.location.assign(url); return; }
    setOpening(false);
  };

  return (
    <div className="skp">
      <div className="skp-label">{t('mp.skin.colonies')}</div>
      {row('city_skin', CITY_SKINS, city, fallbackCity, FREE_CITY_SKIN)}
      <div className="skp-label">{t('mp.skin.stations')}</div>
      {row('station_skin', STATION_SKINS, station, fallbackStation, FREE_STATION_SKIN)}
      {lockedPick && (
        <div className="skp-note" role="status">
          <span>
            {t('mp.skin.locked', {
              pick: lockedPick,
              name: tk('mp.commission.name', COMMISSION_NAME),
              discord: tk('mp.commission.discord', COMMISSION_DISCORD),
              noGameplay: tk('mp.commission.noGameplay', COMMISSION_NO_GAMEPLAY),
            })}
          </span>
          {sellable ? (
            <button type="button" className="skp-buy" disabled={opening} onClick={() => void buy()}>
              {opening ? t('mp.skin.opening') : t('mp.commission.get', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
            </button>
          ) : (
            <span className="skp-dim">{t('mp.skin.dim')}</span>
          )}
        </div>
      )}
    </div>
  );
}
