// ============================================================
// InterceptPicker — the INTERCEPT pop-out (desktop) and sheet page (phone).
//
// Two ways to read the same picks, switched at the top and remembered
// per player:
//   LIST  — one card per group in flight, soonest first.
//   RADAR — your ship in the middle; each group plotted toward where you
//           would meet it, as far out as the meeting is in ticks.
// Both share one selection, one search and one "can't reach" switch, so
// flipping views never loses your place.
//
// Purely presentational: the ship panel and the group bar solve the
// intercepts (game/interceptOptions.ts) and own the orders; this draws
// them and reports clicks.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { ShipIcon, type ShipIconClass, type ShipIconVariant } from './ShipIcons';
import { layoutScope, scopeRadius, scopeTMax, SCOPE_RINGS, type Standing } from '../game/interceptPicker';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './InterceptPicker.css';

export interface PickerEntry {
  key: string;
  name: string;
  ownerName: string;
  ownerColor: string;
  standing: Standing;
  ok: boolean;
  ships: number;
  /** "8× Corvette · 6× Frigate". */
  makeup: string;
  captain: string | null;
  dest: string;
  /** Ticks from now. */
  meetIn: number;
  myEta: number;
  theirEta: number;
  match: boolean;
  /** Bearing of the meeting from you, radians, screen axes. */
  angle: number;
  icon: { cls: ShipIconClass; variant?: ShipIconVariant; parts?: string[]; color?: string; color2?: string };
  /** Lower-case ship, fleet, owner and destination names, for the search. */
  search: string;
}

export interface InterceptPickerProps {
  variant: 'popout' | 'sheet';
  /** Pop-out header ("Intercept · TDS Resolute"); the sheet shows its own title. */
  title?: string;
  /** "Moves all 25 ships of 1st Home Fleet". */
  note?: string | null;
  entries: PickerEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  showing: boolean;
  onShow: () => void;
  onCommit: () => void;
  busy: boolean;
  message?: { kind: 'error' | 'note'; text: string } | null;
  onClose?: () => void;
  /** Sheet only: back to the ship's orders. */
  onBack?: () => void;
  /** Sheet only: compact view after a pick, so the map shows the course. */
  peek?: boolean;
  onUnpeek?: () => void;
  meIcon: React.ReactNode;
  now: number;
  style?: React.CSSProperties;
}

const VIEW_KEY = 'orbital.intercept.view';
type View = 'list' | 'radar';
const readView = (): View => {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'radar'; } catch { return 'radar'; }
};

export const STANDING_RING: Record<Standing, string> = {
  war: '#ff5e5e', allied: '#4ecdc4', peace: '#8a9fb3', yours: '#4fc3f7',
};
const STANDING_CHIP: Record<Standing, () => string> = {
  war: () => t('standing.chip.war'),
  allied: () => t('standing.chip.allied'),
  peace: () => t('standing.chip.peace'),
  yours: () => t('ship.panel.yours'),
};

export const InterceptPicker: React.FC<InterceptPickerProps> = (p) => {
  useI18n();
  const [view, setView] = useState<View>(readView);
  const [query, setQuery] = useState('');
  const [showOut, setShowOut] = useState(false);
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ } }, [view]);

  const needle = query.trim().toLowerCase();
  const hit = (e: PickerEntry) => !needle || e.search.includes(needle);
  const inReach = p.entries.filter(e => e.ok);
  const outReach = p.entries.filter(e => !e.ok);
  const shownIn = inReach.filter(hit);
  const shownOut = showOut ? outReach.filter(hit) : [];
  const selected = p.entries.find(e => e.key === p.selectedKey && e.ok) ?? null;
  const totalShips = inReach.reduce((a, e) => a + e.ships, 0);

  const count = needle
    ? t('ship.rv.matchCount', { n: shownIn.length, total: inReach.length })
    : t('ship.rv.inReach', { n: inReach.length, ships: totalShips });

  const toggle = (
    <div className="ip-seg" role="group" aria-label={t('ship.rv.viewLabel')}>
      <button type="button" className={view === 'list' ? 'is-on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>≡ {t('ship.rv.list')}</button>
      <button type="button" className={view === 'radar' ? 'is-on' : ''} aria-pressed={view === 'radar'} onClick={() => setView('radar')}>◎ {t('ship.rv.radar')}</button>
    </div>
  );

  const body = p.peek && selected ? null : (
    <>
      <div className="ip-row ip-row--top">
        {p.note ? <span className="ip-note">{p.note}</span> : <span />}
        {toggle}
      </div>
      <div className="ip-row">
        <input
          type="search"
          className="rv-search ip-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ship.rv.searchPh')}
          aria-label={t('ship.panel.rvSearchLabel')}
        />
        <span className="ip-count">{count}</span>
      </div>
      {outReach.length > 0 && (
        <label className="ip-out-toggle">
          <input type="checkbox" checked={showOut} onChange={(e) => setShowOut(e.target.checked)} />
          {t('ship.rv.showOut', { n: outReach.length })}
        </label>
      )}
      {inReach.length === 0 && <div className="ip-empty">{t('ship.panel.nothingReach')}</div>}
      {inReach.length > 0 && needle && shownIn.length === 0 && (
        <div className="ip-empty">{t('ship.panel.noContact', { q: query.trim() })}</div>
      )}
      {view === 'list'
        ? <PickerList entries={shownIn} out={shownOut} selectedKey={selected?.key ?? null} onSelect={p.onSelect} sheet={p.variant === 'sheet'} />
        : <PickerRadar entries={inReach} out={showOut ? outReach : []} dimmed={needle ? new Set(inReach.filter(e => !hit(e)).map(e => e.key)) : null}
            selectedKey={selected?.key ?? null} onSelect={p.onSelect} meIcon={p.meIcon} size={p.variant === 'sheet' ? 330 : 360} />}
    </>
  );

  const card = selected && (
    <div className="ip-selected">
      {p.peek && p.onUnpeek && (
        <button type="button" className="maneuver-btn ip-unpeek" onClick={p.onUnpeek}>‹ {t('ship.rv.backToList')}</button>
      )}
      <div className="ip-card is-on ip-card--static">
        <span className="ip-card__l1">
          <ShipIcon size={26} shipClass={selected.icon.cls} variant={selected.icon.variant} parts={selected.icon.parts} color={selected.icon.color} color2={selected.icon.color2} />
          <span className="ip-card__names">
            <span className={`ip-card__name${selected.standing === 'war' ? ' is-war' : ''}`}>{selected.name}</span>
            <span className="ip-card__owner" style={{ color: selected.ownerColor }}>{selected.ownerName}</span>
          </span>
          <span className={`ip-chip ip-chip--${selected.standing}`}>{STANDING_CHIP[selected.standing]()}</span>
        </span>
        <span className="ip-card__meta">
          {tn('ship.rv.ships', selected.ships)} · {selected.makeup}
          {selected.captain ? ` · ${t('ship.rv.capt', { name: selected.captain })}` : ''}
        </span>
      </div>
      <div className="ip-timing">
        {selected.match ? (
          <>
            <span><span>{t('ship.rv.meetFlight')}</span><b>{t('ship.rv.ticksAt', { n: selected.meetIn, tick: p.now + selected.meetIn })}</b></span>
            <span><span>{t('ship.rv.thenFly')}</span><b>{selected.dest}</b></span>
          </>
        ) : (
          <>
            <span><span>{t('ship.rv.youAt', { dest: selected.dest })}</span><b>{t('ship.rv.ticks', { n: selected.myEta })}</b></span>
            <span><span>{t('ship.rv.theyLand')}</span><b>{t('ship.rv.ticksAt', { n: selected.meetIn, tick: p.now + selected.meetIn })}</b></span>
            <span className="ip-spare">{selected.meetIn - selected.myEta > 0 ? t('ship.rv.spare', { n: selected.meetIn - selected.myEta }) : t('ship.rv.justInTime')}</span>
          </>
        )}
      </div>
      {p.message && <div className={`ip-msg ip-msg--${p.message.kind}`}>{p.message.text}</div>}
      <div className="ip-actions">
        <button type="button" className={`maneuver-btn${p.showing ? ' is-armed' : ''}`} onClick={p.onShow}>
          {p.showing ? `◂ ${t('ship.rv.back')}` : `⤢ ${t('ship.rv.show')}`}
        </button>
        <button type="button" className="maneuver-btn ip-commit" disabled={p.busy} onClick={p.onCommit}>
          {selected.match
            ? '⇌ ' + t('ship.panel.matchCourse', { name: selected.name.toUpperCase() })
            : '⇉ ' + t('ship.panel.meetAt', { name: selected.name.toUpperCase(), dest: selected.dest.toUpperCase() })}
        </button>
      </div>
    </div>
  );

  if (p.variant === 'sheet') {
    return (
      <div className={`ip ip--sheet${p.peek && selected ? ' ip--peek' : ''}`} aria-label={t('ship.panel.intercept')}>
        {p.onBack && !(p.peek && selected) && (
          <button type="button" className="maneuver-btn ip-back" onClick={p.onBack}>‹ {t('ship.rv.orders')}</button>
        )}
        {body}
        {card}
      </div>
    );
  }
  return (
    <section className="ip ip--popout modal-content" style={p.style} aria-label={t('ship.panel.intercept')}>
      <div className="modal-header">
        <h3>{p.title}</h3>
        {p.onClose && <button type="button" className="modal-close" aria-label={t('ship.rv.close')} onClick={p.onClose}>✕</button>}
      </div>
      <div className="ip__body">
        {body}
      </div>
      {card && <div className="ip__foot">{card}</div>}
    </section>
  );
};

// ---- LIST ----------------------------------------------------------------

const PickerList: React.FC<{
  entries: PickerEntry[];
  out: PickerEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  sheet: boolean;
}> = ({ entries, out, selectedKey, onSelect, sheet }) => (
  <div className={`ip-list${sheet ? ' ip-list--sheet' : ''}`}>
    {entries.length > 0 && <div className="ip-head">{t('ship.rv.inReachHead')}</div>}
    {entries.map(e => (
      <button
        key={e.key}
        type="button"
        className={`ip-card${e.key === selectedKey ? ' is-on' : ''}`}
        aria-pressed={e.key === selectedKey}
        onClick={() => onSelect(e.key)}
      >
        <span className="ip-card__l1">
          <span className={`ip-card__name${e.standing === 'war' ? ' is-war' : ''}`}>{e.name}</span>
          <span className="ip-card__owner" style={{ color: e.ownerColor }}>{e.ownerName}</span>
          <span className="ip-card__time">{t('ship.rv.ticks', { n: e.meetIn })}</span>
        </span>
        <span className="ip-card__l2">
          <ShipIcon size={22} shipClass={e.icon.cls} variant={e.icon.variant} parts={e.icon.parts} color={e.icon.color} color2={e.icon.color2} />
          <span className="ip-card__meta">{tn('ship.rv.ships', e.ships)} · {e.makeup}</span>
          <span className={`ip-chip ip-chip--${e.standing}`}>{STANDING_CHIP[e.standing]()}</span>
        </span>
        <span className="ip-card__route">
          → {e.dest} · {e.match ? t('ship.panel.matchIn', { n: e.meetIn }) : t('ship.panel.meetIn', { n: e.meetIn })}
          {e.match
            ? <span className="ip-tag ip-tag--match"> ⇌ {t('ship.panel.flyTogether')}</span>
            : <span className="ip-tag"> {e.meetIn - e.myEta > 0 ? t('ship.rv.spare', { n: e.meetIn - e.myEta }) : t('ship.rv.justInTime')}</span>}
        </span>
      </button>
    ))}
    {out.length > 0 && <div className="ip-head ip-head--out">{t('ship.rv.outHead')}</div>}
    {out.map(e => (
      <div key={e.key} className="ip-out">
        <ShipIcon size={20} shipClass={e.icon.cls} variant={e.icon.variant} parts={e.icon.parts} color={e.icon.color} color2={e.icon.color2} />
        <span className="ip-out__names">
          <span className="ip-out__name">{e.name}</span>
          <span className="ip-out__sub">{e.ownerName} · {tn('ship.rv.ships', e.ships)}</span>
        </span>
        <span className="ip-out__why">{t('ship.rv.why', { dest: e.dest, their: e.theirEta, mine: e.myEta })}</span>
      </div>
    ))}
  </div>
);

// ---- RADAR ---------------------------------------------------------------

const PickerRadar: React.FC<{
  entries: PickerEntry[];
  out: PickerEntry[];
  dimmed: Set<string> | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  meIcon: React.ReactNode;
  size: number;
}> = ({ entries, out, dimmed, selectedKey, onSelect, meIcon, size }) => {
  const C = size / 2;
  const R = C - 14;
  const BLIP = size >= 360 ? 32 : 30;
  const tMax = scopeTMax(entries.map(e => e.meetIn));
  const layout = useMemo(
    () => layoutScope(entries.map(e => ({ key: e.key, angle: e.angle, meetIn: e.meetIn, myEta: e.match ? null : e.myEta, size: BLIP })), R, tMax, C),
    [entries, R, tMax, C, BLIP],
  );
  const rings = SCOPE_RINGS.filter(r => r <= tMax);
  const sel = selectedKey ? layout.get(selectedKey) : undefined;
  const selEntry = entries.find(e => e.key === selectedKey);
  // Ring labels along the emptiest diagonal of a typical board (down-right).
  const lab = (r: number) => ({ x: C + r * 0.574 + 3, y: C + r * 0.819 + 3 });
  return (
    <div className="ip-radar" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ip-radar__svg" role="img" aria-label={t('ship.rv.radarAria')}>
        <circle cx={C} cy={C} r={R + 6} className="ip-radar__disc" />
        {rings.map(r => <circle key={r} cx={C} cy={C} r={scopeRadius(r, R, tMax)} className="ip-radar__ring" />)}
        <line x1={C} y1={C - R - 6} x2={C} y2={C + R + 6} className="ip-radar__axis" />
        <line x1={C - R - 6} y1={C} x2={C + R + 6} y2={C} className="ip-radar__axis" />
        {rings.map(r => { const p = lab(scopeRadius(r, R, tMax)); return <text key={r} x={p.x} y={p.y} className="ip-radar__label">{t('ship.rv.ticks', { n: r })}</text>; })}
        {sel && <line x1={C} y1={C} x2={sel.x} y2={sel.y} className="ip-radar__course" />}
        {sel?.pin && selEntry && !selEntry.match && <line x1={sel.pin.x} y1={sel.pin.y} x2={sel.x} y2={sel.y} className="ip-radar__spare" />}
      </svg>
      {out.map(e => {
        const r = scopeRadius(e.meetIn, R, tMax);
        return (
          <span key={e.key} className="ip-ghost" title={t('ship.rv.whyLong', { name: e.name, dest: e.dest, their: e.theirEta, mine: e.myEta })}
            style={{ left: C + Math.cos(e.angle) * r - 3.5, top: C + Math.sin(e.angle) * r - 3.5 }} />
        );
      })}
      {sel?.pin && selEntry && !selEntry.match && (
        <span className="ip-pin" title={t('ship.rv.youAt', { dest: selEntry.dest })} style={{ left: sel.pin.x - 5, top: sel.pin.y - 5 }} />
      )}
      <span className="ip-radar__me" style={{ left: C - 13, top: C - 13 }}>{meIcon}</span>
      {entries.map(e => {
        const pt = layout.get(e.key);
        if (!pt) return null;
        const on = e.key === selectedKey;
        const dim = !!dimmed?.has(e.key) && !on;
        const right = pt.x > C;
        // A crowded scope labels its fleets and the pick; the rest name
        // themselves on hover and in the selected card.
        const labelled = on || entries.length <= 8 || e.ships > 1;
        return (
          <React.Fragment key={e.key}>
            <button
              type="button"
              className={`ip-blip${on ? ' is-on' : ''}${dim ? ' is-dim' : ''}`}
              style={{ left: pt.x - BLIP / 2, top: pt.y - BLIP / 2, width: BLIP, height: BLIP, borderColor: STANDING_RING[e.standing], ['--halo' as string]: STANDING_RING[e.standing] }}
              aria-pressed={on}
              aria-label={t('ship.rv.blipAria', { name: e.name, owner: e.ownerName, dest: e.dest, n: e.meetIn })}
              onClick={() => onSelect(e.key)}
            >
              <ShipIcon size={BLIP - 9} shipClass={e.icon.cls} variant={e.icon.variant} parts={e.icon.parts} color={e.icon.color} color2={e.icon.color2} />
              {e.ships > 1 && <span className="ip-blip__n">{e.ships}</span>}
            </button>
            {labelled && <span
              className={`ip-blip__label${e.standing === 'war' ? ' is-war' : ''}${dim ? ' is-dim' : ''}`}
              style={right
                ? { left: pt.x + BLIP / 2 + 5, top: pt.y - 8 }
                : { right: size - (pt.x - BLIP / 2 - 5), top: pt.y - 8 }}
            >
              {e.name}<span className="ip-blip__when"> · {t('ship.rv.ticks', { n: e.meetIn })}</span>
            </span>}
          </React.Fragment>
        );
      })}
    </div>
  );
};
