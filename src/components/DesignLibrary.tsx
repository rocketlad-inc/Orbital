// ============================================================
// DesignLibrary — every design a player owns, in one place (Shipwright,
// 2026-10-08). Opened from the designer's left column; it takes over the
// designer's body and hands a pick back:
//   - THIS GAME: Edit (into the designer) or Set active.
//   - ACCOUNT templates and PAST GAMES: Load (a fresh draft in this game,
//     so this game's research still decides what fits).
// Every hull is drawn in the empire's colours, as on the map.
// ============================================================

import React, { useMemo, useState } from 'react';
import { ShipIcon, ICON_VARIANT_NAMES, DEFAULT_SHIP_ICONS } from './ShipIcons';
import type { ShipIconVariant } from './ShipIcons';
import { SHIP_CLASSES, BUILDABLE_CLASSES, BuildableClassName, ShipClassName } from '../game/shipClasses';
import { SHIP_SLOT_COUNTS, PART_GLYPH, partsCost, sanitizeParts } from '../game/shipParts';
import type { ShipPartId } from '../game/shipParts';
import type { ShipDesign } from '../types';
import { t } from '../i18n/core';

export interface LibraryTemplate {
  id: string;
  shipClass: ShipClassName;
  name: string;
  parts: string[];
  iconVariant?: ShipDesign['iconVariant'];
  gameName?: string | null;
}

type Origin = 'all' | 'game' | 'account' | 'past';
/** The hulls a look can be drawn for (capital hulls have their own art). */
type IconCls = keyof typeof DEFAULT_SHIP_ICONS;

interface Props {
  designs: ShipDesign[];
  templates: LibraryTemplate[];
  pastDesigns: LibraryTemplate[];
  initialClass: BuildableClassName;
  p1: string;
  p2: string;
  busy: boolean;
  priced: (n: number) => number;
  onEdit: (d: ShipDesign) => void;
  onSetActive: (d: ShipDesign) => void;
  onLoad: (tpl: LibraryTemplate) => void;
  onDeleteTemplate: (tpl: LibraryTemplate) => void;
  onClose: () => void;
}

export const DesignLibrary: React.FC<Props> = ({
  designs, templates, pastDesigns, initialClass, p1, p2, busy, priced,
  onEdit, onSetActive, onLoad, onDeleteTemplate, onClose,
}) => {
  const [origin, setOrigin] = useState<Origin>('all');
  const [cls, setCls] = useState<BuildableClassName | 'all'>(initialClass);
  const [q, setQ] = useState('');

  const classes = BUILDABLE_CLASSES.filter(c => (SHIP_SLOT_COUNTS[c] ?? 0) > 0);
  const matches = (shipClass: string, name: string, parts: readonly string[]) => {
    if (cls !== 'all' && shipClass !== cls) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return name.toLowerCase().includes(needle)
      || parts.some(p => p.toLowerCase().includes(needle))
      || (SHIP_CLASSES[shipClass as ShipClassName]?.displayName ?? '').toLowerCase().includes(needle);
  };
  const game = useMemo(() => designs.filter(d => matches(d.shipClass, d.name, d.parts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [designs, cls, q]);
  const account = useMemo(() => templates.filter(d => matches(d.shipClass, d.name, d.parts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [templates, cls, q]);
  const past = useMemo(() => pastDesigns.filter(d => matches(d.shipClass, d.name, d.parts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pastDesigns, cls, q]);

  const costOf = (shipClass: ShipClassName, parts: readonly string[]) => {
    const def = SHIP_CLASSES[shipClass];
    const pc = partsCost(sanitizeParts(parts), shipClass);
    return `${priced(def.cost.ore + pc.ore)}m · ${priced(def.cost.credits + pc.credits)}c`;
  };
  const lookOf = (shipClass: ShipClassName, v?: ShipDesign['iconVariant']) => {
    const ic = shipClass as IconCls;
    return ICON_VARIANT_NAMES[ic]?.[(v ?? DEFAULT_SHIP_ICONS[ic]) as ShipIconVariant] ?? '';
  };
  const glyphs = (parts: readonly string[]) =>
    parts.length === 0 ? t('ship.sd.bareHull') : parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ');

  const card = (
    key: string, shipClass: ShipClassName, name: string, parts: readonly string[],
    iconVariant: ShipDesign['iconVariant'] | undefined, originLabel: string, originKind: Origin,
    active: boolean, actions: React.ReactNode,
  ) => (
    <div key={key} className={`sd-dl__card ${active ? 'is-active' : ''}`}>
      <div className="sd-dl__cardhead">
        <span className={`sd-dl__origin sd-dl__origin--${originKind}`}>{originLabel}</span>
        {active && <span className="sd-badge">{t('ship.sd.active')}</span>}
      </div>
      <div className="sd-dl__cardbody">
        <ShipIcon shipClass={shipClass as IconCls} variant={iconVariant} size={80} color={p1} color2={p2} />
        <span className="sd-dl__text">
          <span className="sd-dl__name">{name}</span>
          <span className="sd-dl__meta">{SHIP_CLASSES[shipClass].displayName} · {lookOf(shipClass, iconVariant)}</span>
          <span className="sd-dl__parts">{glyphs(parts)}</span>
          <span className="sd-dl__cost">{costOf(shipClass, parts)}</span>
        </span>
      </div>
      <div className="sd-dl__acts">{actions}</div>
    </div>
  );

  const show = (o: Origin) => origin === 'all' || origin === o;
  const total = game.length + account.length + past.length;

  return (
    <div className="sd-dl" data-testid="design-library">
      <div className="sd-dl__bar">
        <button className="sd-mini-btn" onClick={onClose}>‹ {t('ship.sd.title')}</button>
        <span className="sd-dl__title">{t('ship.sd.dl.title')}</span>
        <span className="sd-dl__count">{t('ship.sd.dl.count', { n: total })}</span>
        <label className="sd-dl__search">
          <span className="sd-visually-hidden">{t('ship.sd.dl.search')}</span>
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('ship.sd.dl.search')} />
        </label>
      </div>
      <div className="sd-dl__filters" role="tablist">
        {([['all', 'ship.sd.dl.all'], ['game', 'ship.sd.dl.game'], ['account', 'ship.sd.dl.account'], ['past', 'ship.sd.dl.past']] as const).map(([k, key]) => (
          <button key={k} role="tab" aria-selected={origin === k} className={`sd-sidetab ${origin === k ? 'active' : ''}`} onClick={() => setOrigin(k)}>
            {t(key)}
          </button>
        ))}
        <span className="sd-dl__sep" aria-hidden />
        <button role="tab" aria-selected={cls === 'all'} className={`sd-sidetab ${cls === 'all' ? 'active' : ''}`} onClick={() => setCls('all')}>
          {t('ship.sd.dl.allHulls')}
        </button>
        {classes.map(c => (
          <button key={c} role="tab" aria-selected={cls === c} className={`sd-sidetab ${cls === c ? 'active' : ''}`} onClick={() => setCls(c)}>
            {SHIP_CLASSES[c].displayName}
          </button>
        ))}
      </div>
      <div className="sd-dl__grid">
        {total === 0 && <div className="sd-hint">{t('ship.sd.dl.empty')}</div>}
        {show('game') && game.map(d => card(d.id, d.shipClass, d.name, d.parts, d.iconVariant, t('ship.sd.dl.originGame'), 'game', d.isActive,
          <>
            <button className="sd-mini-btn sd-mini-btn--go" disabled={busy} onClick={() => onEdit(d)}>{t('ship.sd.dl.edit')}</button>
            {!d.isActive && <button className="sd-mini-btn" disabled={busy} onClick={() => onSetActive(d)}>{t('ship.sd.setActive')}</button>}
          </>))}
        {show('account') && account.map(tpl => card(tpl.id, tpl.shipClass, tpl.name, tpl.parts, tpl.iconVariant, t('ship.sd.dl.originAccount'), 'account', false,
          <>
            <button className="sd-mini-btn sd-mini-btn--go" disabled={busy} onClick={() => onLoad(tpl)}>{t('ship.sd.load')}</button>
            <button className="sd-mini-btn sd-mini-btn--danger" disabled={busy} onClick={() => onDeleteTemplate(tpl)}
              aria-label={t('ship.sd.deleteTemplateTip')} title={t('ship.sd.deleteTemplateTip')}>✕</button>
          </>))}
        {show('past') && past.map(tpl => card(tpl.id, tpl.shipClass, tpl.name, tpl.parts, tpl.iconVariant, tpl.gameName ?? t('ship.sd.dl.originPast'), 'past', false,
          <button className="sd-mini-btn sd-mini-btn--go" disabled={busy} onClick={() => onLoad(tpl)}>{t('ship.sd.load')}</button>))}
      </div>
    </div>
  );
};
