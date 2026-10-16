// ============================================================
// THE MAP MAKER (Lorne, 2026-10-14): build a star system, then host a
// game on it. Anyone can build and save; hosting a game on your own map
// is the Commander's Commission; anyone can join one.
//
// Design: the "Orbital Map Maker" canvas (5 boards). Format and rules:
// src/game/customMap.js, shared with the server. Server:
// worker/customMaps.js + index.js handleHostMap. Staging only for now.
//
// Round two (2026-10-15): a phone layout on the game's own touch rules
// (drag pans, pinch zooms, long-press gathers), the game's real planet
// art, symmetry and a fairness lens, lore, paint tools, moods, autosave
// and a public gallery to remix from.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './mapmaker.css';
import { apiFetch, startCommissionCheckout } from '../multiplayer/api';
import { canBuyHere, openCommissionInBrowser } from '../multiplayer/commission';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  type CustomMap, type MapIssue, type MapBodyType, type MapBackdrop, blankMap, normalizeMap, checkMap, generateMap, startWorlds, sectorOf,
  NAME_THEMES, TYPE_INFO,
} from '../game/customMap';
import { getLang, t, tn, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { tMarkup, tRich } from '../i18n/rich';
import { MapView, type Tool } from './MapView';
import { BodyInspector, SunInspector, MapInspector, SectorInspector, BulkBar, Stepper, FieldGroup } from './Inspector';
import { typeLabel, themeLabel, backdropLabel, issueText, issueTitle, mapApiError, touchKey } from './mmText';
import {
  placeBody, deleteBodies, duplicateBodies, placeSymmetric, ringOf, scatterAsteroids, matchBodies, type MatchAspect,
  addSector, deleteSectors,
} from './ops';
import { fairness } from './fairness';
import type { Scale } from './geometry';

type Summary = {
  id: string; name: string; share_code: string; updated_ms: number; hosted_count: number;
  bodies: number; blockers: number; warnings: number; sun_color: string;
  published?: boolean; remix_count?: number; blurb?: string;
};
type Thumb = { sun: { color: string; size: number }; backdrop?: MapBackdrop; bodies: Array<[number, number, number, string, string]> };
type GalleryItem = {
  id: string; name: string; blurb: string; author: string; hosted_count: number; remix_count: number;
  published_ms: number; bodies: number; starts: number; thumb: Thumb; mine: boolean;
};
type Hist = { past: CustomMap[]; present: CustomMap; future: CustomMap[] };

const DRAFT_KEY = 'orbital.mapmaker.draft';
const COACH_KEY = 'orbital.mapmaker.coached';
/** The world tools, labelled at render (typeLabel) in the player's language. */
const PALETTE: Array<MapBodyType | 'belt'> = ['terrestrial', 'gas-giant', 'ice-giant', 'moon', 'dwarf', 'belt', 'asteroid', 'rock'];
const RING_TYPES: MapBodyType[] = ['terrestrial', 'dwarf', 'gas-giant', 'ice-giant', 'asteroid'];
const SYMMETRY = [1, 2, 3, 4, 5, 6, 8];
/** What a share code looks like (a format, not words). */
const CODE_EXAMPLE = 'ORB-7KQ2-HELN';

/** A name the maker gives a map, in the player's language at the moment
 *  it is made: a Portuguese player's remix is "X (cópia)", not "X (copy)".
 *  The server names copies in English; the client renames them. */
function localCopyName(name: string): string {
  const m = / \(copy\)$/.exec(name);
  return m && getLang() !== 'en' ? t('mm.name.copy', { name: name.slice(0, m.index) }) : name;
}

/** Open a map in the workshop. `dirty`: it holds changes the server does
 *  not have yet (a renamed copy, a recovered draft), so it autosaves
 *  straight away. `base`: the server's updated_ms for the version this
 *  starts from, so a save never writes over a newer one made elsewhere. */
type OpenMap = (map: CustomMap, id: string | null, opts?: OpenOpts) => void;

/** Open a copy the server just made (a remix or an imported code). */
function openCopy(onOpen: OpenMap, raw: CustomMap, s: Summary) {
  const map = normalizeMap(raw);
  const name = localCopyName(map.name);
  onOpen(name === map.name ? map : normalizeMap({ ...map, name }), s.id, { dirty: name !== map.name, base: s.updated_ms ?? null });
}

/**
 * THE DRAFT: one slot on this device holding changes not yet saved, so
 * a closed tab or a dropped connection loses nothing. It is written only
 * while there ARE unsaved changes (opening a template never overwrites
 * it) and cleared once that map saves. `sid` names the workshop session
 * that wrote it.
 */
type Draft = { map: CustomMap; id: string | null; base: number | null; sid: string; at: number };
function saveDraft(d: Omit<Draft, 'at'>) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, at: Date.now() })); } catch { /* private mode */ }
}
function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return {
      map: normalizeMap(d.map), id: typeof d.id === 'string' ? d.id : null,
      base: Number.isFinite(d.base) ? Number(d.base) : null, sid: typeof d.sid === 'string' ? d.sid : '', at: Number(d.at) || 0,
    };
  } catch { return null; }
}
/** Drop the draft if it is this session's or this map's. */
function clearDraft(sid: string, id: string | null) {
  try {
    const d = loadDraft();
    if (d && (d.sid === sid || (id && d.id === id))) localStorage.removeItem(DRAFT_KEY);
  } catch { /* private mode */ }
}

/** A field that brings up the keyboard (so the phone sheet makes room). */
function typesText(el: EventTarget | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && ['text', 'search', 'number', 'email', 'password', 'url', 'tel'].includes(el.type);
}

/** A dialog over the page: it takes focus, closes on Escape, and hands
 *  focus back to whatever had it when it shuts. */
function useModal(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (before && document.contains(before)) before.focus?.(); };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Not the workshop's own Escape (which clears the selection) too.
    e.stopPropagation();
    close.current();
  };
  return { ref, onKeyDown, tabIndex: -1, 'aria-modal': true as const };
}
function coached(): boolean { try { return localStorage.getItem(COACH_KEY) === '1'; } catch { return true; } }
function markCoached() { try { localStorage.setItem(COACH_KEY, '1'); } catch { /* private mode */ } }

function PaletteIcon({ tool }: { tool: Tool }) {
  if (tool === 'belt') return <span className="mm-pal__belt" aria-hidden />;
  if (tool === 'rock') return <span className="mm-pal__rock" aria-hidden />;
  if (tool === 'scatter') return <span className="mm-pal__spray" aria-hidden />;
  if (tool === 'ring') return <span className="mm-pal__ringtool" aria-hidden />;
  if (tool === 'sector') return <span className="mm-pal__sector" aria-hidden />;
  const ty = tool as MapBodyType;
  const d = { terrestrial: 22, 'gas-giant': 30, 'ice-giant': 26, moon: 14, dwarf: 16, asteroid: 10, rock: 8 }[ty] ?? 16;
  const c = TYPE_INFO[ty].color;
  const gas = ty === 'gas-giant';
  return (
    <span
      className="mm-pal__disc" aria-hidden
      style={{
        width: d, height: d,
        background: gas
          ? `repeating-linear-gradient(170deg, ${c} 0 4px, #9a6236 4px 8px)`
          : `radial-gradient(circle at 35% 32%, #fff8, ${c} 55%, #0009)`,
      }}
    />
  );
}

/** A mini system from a gallery thumb or a whole map. */
function MiniSystem({ thumb, size = 120 }: { thumb: Thumb; size?: number }) {
  const max = Math.max(200, ...thumb.bodies.map(b => b[0]));
  const k = (size / 2 - 8) / Math.sqrt(max);
  const sun = Math.max(4, Math.min(10, thumb.sun.size / 6));
  return (
    <svg className={`mm-mini is-${thumb.backdrop ?? 'deep'}`} width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} aria-hidden>
      {[...new Set(thumb.bodies.filter(b => b[4] !== 'asteroid').map(b => Math.round(b[0])))].map(o => (
        <circle key={o} r={k * Math.sqrt(o)} fill="none" stroke="#2a3d50" strokeWidth={0.7} />
      ))}
      <circle r={sun * 2} fill={thumb.sun.color} opacity={0.18} />
      <circle r={sun} fill={thumb.sun.color} />
      {thumb.bodies.map((b, i) => {
        const r = k * Math.sqrt(b[0]);
        const d = b[4] === 'asteroid' || b[4] === 'rock' ? 0.9 : Math.max(1.6, Math.min(5, 1 + b[2] * 0.5));
        return <circle key={i} cx={Math.cos(b[1]) * r} cy={Math.sin(b[1]) * r} r={d} fill={b[3]} />;
      })}
    </svg>
  );
}
function thumbOf(map: CustomMap): Thumb {
  return {
    sun: { color: map.sun.color, size: map.sun.size }, backdrop: map.settings.backdrop,
    bodies: map.bodies.filter(b => b.parent === 'sun').map(b => [b.orbit, b.angle, b.radius, b.color, b.type]),
  };
}

/** The issue chip's drawer. */
function Checklist({ issues, onShow, onClose }: { issues: MapIssue[]; onShow: (ids: string[]) => void; onClose: () => void }) {
  useI18n();
  const modal = useModal(onClose);
  return (
    <div className="mm-drawer" role="dialog" aria-label={t('mm.check.title')} {...modal}>
      <div className="mm-drawer__head">
        <b>{t('mm.check.title')}</b>
        <span className="mm-mono">{t('mm.check.live')}</span>
        <button className="mm-icon" aria-label={t('mm.close')} onClick={onClose}>✕</button>
      </div>
      {[...issues].sort((a, b) => ({ block: 0, warn: 1, ok: 2 }[a.level] - { block: 0, warn: 1, ok: 2 }[b.level])).map(i => {
        const tx = issueText(i);
        return (
          <div key={i.code} className={`mm-issue is-${i.level}`}>
            <span className="mm-issue__mark" aria-hidden>{i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'}</span>
            <div className="mm-issue__t">
              <b>{tx.title}</b>
              <span>{tx.detail}</span>
            </div>
            {i.level !== 'ok' && i.bodyIds.length > 0 && <button className="mm-btn is-small" onClick={() => onShow(i.bodyIds)}>{t('mm.check.showMe')}</button>}
          </div>
        );
      })}
    </div>
  );
}

/** Share, publish and host. */
function HostPanel({
  map, summary, canHost, onSaveFirst, onToggleSecrets, onPublished, onEditPitch, onClose,
}: {
  map: CustomMap; summary: Summary | null; canHost: boolean;
  onSaveFirst: () => Promise<Summary | null>; onToggleSecrets: (on: boolean) => void;
  onPublished: (s: Summary) => void; onEditPitch: () => void; onClose: () => void;
}) {
  useI18n();
  const starts = startWorlds(map).worlds.length;
  const most = Math.max(2, Math.min(10, starts));
  const [seats, setSeats] = useState(most);
  const [name, setName] = useState(map.name);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const blockers = checkMap(map).filter(i => i.level === 'block');
  const sellable = canBuyHere();
  const published = !!summary?.published;
  const modal = useModal(onClose);

  const host = async () => {
    setBusy(true); setError(null);
    // The lobby copies the saved map, so save what's on screen first.
    const s = await onSaveFirst();
    if (!s) { setBusy(false); setError(t('mm.host.saveFailed')); return; }
    const res = await apiFetch<{ room: { id: string } }>(`/api/maps/${s.id}/host`, {
      method: 'POST', body: JSON.stringify({ name, max_players: seats, password: password || undefined }),
    });
    setBusy(false);
    if (!res.ok) { setError(mapApiError(res.error, 'mm.host.openFailed')); return; }
    try { sessionStorage.setItem('orbital.tab_room', res.data.room.id); } catch { /* private mode */ }
    window.location.href = '/';
  };
  const publish = async (on: boolean) => {
    setPubBusy(true); setPubError(null);
    const s = await onSaveFirst();
    if (!s) { setPubBusy(false); setPubError(t('mm.pub.saveFirst')); return; }
    const res = await apiFetch<{ summary: Summary }>(`/api/maps/${s.id}/publish`, { method: 'POST', body: JSON.stringify({ on }) });
    setPubBusy(false);
    if (!res.ok) { setPubError(mapApiError(res.error, 'mm.pub.failed')); return; }
    onPublished(res.data.summary);
  };
  const buy = async () => {
    const url = await startCommissionCheckout('map-maker');
    if (url) window.location.href = url;
  };

  return (
    <div className="mm-modal" role="dialog" aria-label={t('mm.host.aria')} {...modal}>
      <div className="mm-modal__card">
        <div className="mm-modal__head"><b>{t('mm.host.title')}</b><button className="mm-icon" aria-label={t('mm.close')} onClick={onClose}>✕</button></div>
        <div className="mm-modal__cols">
          <div className="mm-modal__stack">
            <section className="mm-panel">
              <h3>{t('mm.share.title')}</h3>
              {summary ? (
                <>
                  <div className="mm-row">
                    <input className="mm-input is-code" readOnly value={summary.share_code} aria-label={t('mm.share.codeAria')} />
                    <button className="mm-btn" onClick={() => { navigator.clipboard?.writeText(summary.share_code); setCopied(true); }}>{copied ? t('mm.share.copied') : t('mm.share.copy')}</button>
                  </div>
                  <p className="mm-note">{t('mm.share.note')}</p>
                </>
              ) : <p className="mm-note">{t('mm.share.needSave')}</p>}
              <label className="mm-check">
                <input type="checkbox" checked={map.settings.shareHidesSecrets} onChange={(e) => onToggleSecrets(e.target.checked)} />
                <span>{t('mm.share.hideSecrets')}</span>
              </label>
            </section>
            <section className="mm-panel">
              <h3>{t('mm.pub.title')}</h3>
              <div className="mm-pub">
                <MiniSystem thumb={thumbOf(map)} size={86} />
                <div className="mm-pub__t">
                  <b>{map.name}</b>
                  {map.blurb
                    ? <span className="mm-note">{map.blurb}</span>
                    : <span className="mm-note is-dim">{tRich('mm.pub.noPitch', { link: <button className="mm-link" onClick={onEditPitch}>{t('mm.pub.writeOne')}</button> })}</span>}
                </div>
              </div>
              {blockers.length > 0 && !published ? (
                <p className="mm-note is-bad">{t('mm.pub.fixFirst', { list: blockers.map(issueTitle).join('; ') })}</p>
              ) : (
                <button className={`mm-btn is-wide${published ? '' : ' is-teal'}`} disabled={pubBusy} onClick={() => publish(!published)}>
                  {pubBusy ? '…' : published ? t('mm.pub.unpublish') : t('mm.pub.publish')}
                </button>
              )}
              {published && <p className="mm-note">{t('mm.pub.live', { remixed: summary?.remix_count ?? 0, hosted: summary?.hosted_count ?? 0 })}</p>}
              {pubError && <p className="mm-note is-bad">{pubError}</p>}
            </section>
          </div>
          <section className="mm-panel is-gold">
            <h3>{t('mm.host.heading', { name: map.name })}</h3>
            {blockers.length > 0 ? (
              <p className="mm-note is-bad">{t('mm.host.notYet', { list: blockers.map(issueTitle).join('; ') })}</p>
            ) : canHost ? (
              <>
                <div className="mm-grid2">
                  <label className="mm-field"><span className="mm-field__l">{t('mm.host.lobbyName')}</span>
                    <input className="mm-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <FieldGroup label={t('mm.host.seats', { n: most })}>
                    <Stepper label={t('mm.host.seatsAria')} value={seats} min={2} max={most} onChange={setSeats} />
                  </FieldGroup>
                  <label className="mm-field"><span className="mm-field__l">{t('mm.host.password')}</span>
                    <input className="mm-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </div>
                <button className="mm-btn is-gold is-wide" disabled={busy} onClick={host}>{busy ? t('mm.host.opening') : t('mm.host.open')}</button>
                {error && <p className="mm-note is-bad">{error}</p>}
                <p className="mm-note">{t('mm.host.copyNote')}</p>
              </>
            ) : (
              <>
                <p className="mm-note">{t('mm.host.needCommission', { name: t('hangar.commissionName'), price: t('mp.commission.price') })}</p>
                {sellable ? (
                  <button className="mm-btn is-gold is-wide" onClick={buy}>{t('feed.buy', { price: t('mp.commission.price') })}</button>
                ) : (
                  <button className="mm-btn is-gold is-wide" onClick={() => openCommissionInBrowser('map-maker')}>{t('mp.commission.inBrowser', { price: t('mp.commission.price') })}</button>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The public gallery: everyone's published maps, to play or remix. */
function Gallery({ onOpen }: { onOpen: OpenMap }) {
  useI18n();
  const [sort, setSort] = useState<'popular' | 'new'>('popular');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ item: GalleryItem; map: CustomMap; canModerate?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(async () => {
      const res = await apiFetch<{ items: GalleryItem[]; next: string | null }>(`/api/maps/gallery?sort=${sort}&q=${encodeURIComponent(q.trim())}&limit=30`);
      if (!live) return;
      if (res.ok) { setItems(res.data.items); setError(null); } else setError(mapApiError(res.error, 'mm.gal.loadFailed'));
    }, q ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [sort, q]);

  const look = async (item: GalleryItem) => {
    const res = await apiFetch<{ map: CustomMap; item: GalleryItem; can_moderate?: boolean }>(`/api/maps/gallery/${item.id}`);
    if (res.ok) setPeek({ item: res.data.item ?? item, map: normalizeMap(res.data.map), canModerate: !!res.data.can_moderate });
    else setError(mapApiError(res.error, 'mm.gal.openFailed'));
  };
  const takedown = async (item: GalleryItem) => {
    setBusy(true);
    const res = await apiFetch(`/api/maps/${item.id}/takedown`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) { setError(mapApiError(res.error, 'mm.gal.takedownFailed')); return; }
    setPeek(null);
    setItems(list => (list ?? []).filter(i => i.id !== item.id));
  };
  const remix = async (item: GalleryItem) => {
    setBusy(true);
    const res = await apiFetch<{ map: CustomMap; summary: Summary }>(`/api/maps/${item.id}/remix`, { method: 'POST' });
    setBusy(false);
    if (res.ok) openCopy(onOpen, res.data.map, res.data.summary);
    else setError(mapApiError(res.error, 'mm.gal.remixFailed'));
  };

  return (
    <div className="mm-gallery">
      <div className="mm-row mm-row--wrap">
        <div className="mm-seg">
          <button className={`mm-chip${sort === 'popular' ? ' is-on' : ''}`} onClick={() => setSort('popular')}>{t('mm.gal.popular')}</button>
          <button className={`mm-chip${sort === 'new' ? ' is-on' : ''}`} onClick={() => setSort('new')}>{t('mm.gal.newest')}</button>
        </div>
        <span className="mm-top__fill" />
        <input className="mm-input mm-gallery__q" placeholder={t('mm.gal.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('mm.gal.search')} />
      </div>
      {error && <p className="mm-note is-bad">{error}</p>}
      {items === null && !error && <p className="mm-note">{t('mm.gal.loading')}</p>}
      {items?.length === 0 && <p className="mm-note">{q ? t('mm.gal.noMatch') : t('mm.gal.empty')}</p>}
      <div className="mm-gallery__grid">
        {items?.map(it => (
          <button key={it.id} className="mm-gcard" onClick={() => look(it)}>
            <MiniSystem thumb={it.thumb} size={140} />
            <span className="mm-gcard__t">
              <b>{it.name}</b>
              <span className="mm-mono">{t(it.mine ? 'mm.gal.byYou' : 'mm.gal.by', { name: it.author })}</span>
              {it.blurb && <span className="mm-gcard__blurb">{it.blurb}</span>}
              <span className="mm-mono">
                {[tn('mm.n.seats', it.starts), tn('mm.n.bodies', it.bodies), t('mm.played', { n: it.hosted_count }), t('mm.remixed', { n: it.remix_count })].join(' · ')}
              </span>
            </span>
          </button>
        ))}
      </div>
      {peek && (
        <GalleryPeek item={peek.item} map={peek.map} busy={busy} onRemix={() => remix(peek.item)} onClose={() => setPeek(null)}
          canModerate={peek.canModerate} onTakedown={() => takedown(peek.item)} />
      )}
    </div>
  );
}

/** One gallery map, close up, with its remix button. */
function GalleryPeek({ item, map, busy, onRemix, onClose, canModerate, onTakedown }: {
  item: GalleryItem; map: CustomMap; busy: boolean; onRemix: () => void; onClose: () => void;
  canModerate?: boolean; onTakedown?: () => void;
}) {
  useI18n();
  const modal = useModal(onClose);
  return (
    <div className="mm-modal" role="dialog" aria-label={item.name} {...modal}>
      <div className="mm-modal__card is-narrow">
        <div className="mm-modal__head"><b>{item.name}</b><button className="mm-icon" aria-label={t('mm.close')} onClick={onClose}>✕</button></div>
        <div className="mm-peek">
          <MiniSystem thumb={thumbOf(map)} size={260} />
          <div className="mm-peek__t">
            <span className="mm-mono">{t('mm.gal.by', { name: item.author })}</span>
            {map.blurb && <p className="mm-peek__blurb">{map.blurb}</p>}
            <span className="mm-mono">
              {[tn('mm.n.startWorlds', startWorlds(map).worlds.length), tn('mm.n.bodies', map.bodies.length), backdropLabel(map.settings.backdrop)].join(' · ')}
            </span>
            <span className="mm-mono">{t('mm.played', { n: item.hosted_count })} · {t('mm.remixed', { n: item.remix_count })}</span>
            <button className="mm-btn is-primary is-wide" disabled={busy} onClick={onRemix}>
              {busy ? t('mm.gal.copying') : item.mine ? t('mm.gal.openCopy') : t('mm.gal.remix')}
            </button>
            <p className="mm-note">{t('mm.gal.remixNote')}</p>
            {/* Moderation: admins take a map out of the gallery for good. */}
            {canModerate && onTakedown && !item.mine && (
              <button className="mm-btn is-danger is-wide" disabled={busy}
                onClick={() => { if (window.confirm(t('mm.gal.takedownConfirm', { name: item.name }))) onTakedown(); }}>
                {t('mm.gal.takedown')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The first screen: templates, the generator, your maps, the gallery. */
function StartScreen({ onOpen, onExit }: { onOpen: OpenMap; onExit: () => void }) {
  useI18n();
  const [tab, setTab] = useState<'build' | 'gallery'>('build');
  const [maps, setMaps] = useState<Summary[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState({ planets: 7, moonsMin: 0, moonsMax: 3, belts: 1, richness: 1, starts: 8, spread: 1, theme: 'Mythic', seed: Math.floor(Math.random() * 99999) });
  const draft = useMemo(loadDraft, []);

  const refresh = useCallback(async () => {
    const res = await apiFetch<{ maps: Summary[] }>('/api/maps');
    if (res.ok) setMaps(res.data.maps);
    else setError(res.status === 404 ? t('mm.start.closed') : mapApiError(res.error, 'mm.start.loadFailed'));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const open = async (id: string) => {
    const res = await apiFetch<{ map: CustomMap; summary?: Summary }>(`/api/maps/${id}`);
    if (res.ok) onOpen(normalizeMap(res.data.map), id, { base: res.data.summary?.updated_ms ?? null });
    else setError(mapApiError(res.error, 'mm.start.openFailed'));
  };
  const remove = async (s: Summary) => {
    if (!window.confirm(t('mm.start.deleteConfirm', { name: s.name }))) return;
    await apiFetch(`/api/maps/${s.id}`, { method: 'DELETE' });
    refresh();
  };
  const importCode = async () => {
    setError(null);
    const res = await apiFetch<{ map: CustomMap; summary: Summary }>('/api/maps/import', { method: 'POST', body: JSON.stringify({ code }) });
    if (res.ok) openCopy(onOpen, res.data.map, res.data.summary);
    else setError(mapApiError(res.error, 'mm.start.codeFailed'));
  };
  const sol = async () => {
    const res = await apiFetch<{ map: CustomMap }>('/api/maps/template/sol');
    if (!res.ok) { setError(mapApiError(res.error, 'mm.start.solFailed')); return; }
    const m = normalizeMap(res.data.map);
    // The server names the template in English; a fresh map takes the player's language.
    onOpen(getLang() !== 'en' && m.name === 'Our Solar System' ? { ...m, name: t('mm.tpl.sol.t') } : m, null);
  };
  /** A rolled system, named in the player's language ("Sistema Helion"). */
  const roll = () => {
    const m = generateMap({ ...gen });
    onOpen(getLang() === 'en' ? m : normalizeMap({ ...m, name: t('mm.name.generated', { sun: m.sun.name }) }), null);
  };
  const slider = (key: keyof typeof gen, label: string, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="mm-field">
      <span className="mm-field__l mm-field__l--row"><span>{label}</span><b className="mm-mono">{fmt(gen[key] as number)}</b></span>
      <input type="range" className="mm-range" min={min} max={max} step={step} value={gen[key] as number}
        onChange={(e) => setGen({ ...gen, [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="mm-start">
      <header className="mm-top">
        <button className="mm-brand" onClick={onExit} title={t('mm.backToLobby')}>‹ {t('mm.brand')}</button>
        <div className="mm-seg mm-top__tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'build'} className={`mm-chip${tab === 'build' ? ' is-on' : ''}`} onClick={() => setTab('build')}>{t('mm.start.tabBuild')}</button>
          <button role="tab" aria-selected={tab === 'gallery'} className={`mm-chip${tab === 'gallery' ? ' is-on' : ''}`} onClick={() => setTab('gallery')}>{t('mm.start.tabGallery')}</button>
        </div>
        <span className="mm-top__fill" />
        <label className="mm-top__code">
          <span>{t('mm.start.haveCode')}</span>
          <input className="mm-input" placeholder={CODE_EXAMPLE} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') importCode(); }} />
        </label>
        <button className="mm-btn is-teal" onClick={importCode} disabled={!code.trim()}>{t('mm.start.open')}</button>
      </header>
      {tab === 'gallery' ? (
        <div className="mm-start__body is-single">
          <div className="mm-start__main">
            <h1 className="mm-h1">{t('mm.gal.h1')}</h1>
            <p className="mm-note">{t('mm.gal.intro')}</p>
            <Gallery onOpen={onOpen} />
          </div>
        </div>
      ) : (
        <div className="mm-start__body">
          <div className="mm-start__main">
            <h1 className="mm-h1">{t('mm.start.h1')}</h1>
            <p className="mm-note">{t('mm.start.intro')}</p>
            {error && <p className="mm-note is-bad">{error}</p>}
            <div className="mm-templates">
              <button className="mm-tpl" onClick={() => onOpen(blankMap(t('mm.name.mySystem')), null)}>
                <span className="mm-tpl__art is-blank" aria-hidden><span className="mm-tpl__sun" /></span>
                <b>{t('mm.tpl.blank.t')}</b><span>{t('mm.tpl.blank.d')}</span>
              </button>
              <button className="mm-tpl" onClick={sol}>
                <span className="mm-tpl__art is-sol" aria-hidden><span className="mm-tpl__sun" /></span>
                <b>{t('mm.tpl.sol.t')}</b><span>{t('mm.tpl.sol.d')}</span>
              </button>
              <button className="mm-tpl" onClick={() => setTab('gallery')}>
                <span className="mm-tpl__art is-gallery" aria-hidden><span className="mm-tpl__sun" /></span>
                <b>{t('mm.tpl.remix.t')}</b><span>{t('mm.tpl.remix.d')}</span>
              </button>
              {draft && draft.map.bodies.length > 0 && (
                <button className="mm-tpl" onClick={() => onOpen(draft.map, draft.id, {
                  // A draft from before 2026-10-15 (no sid) was written on
                  // every change, saved or not: it opens as it always did.
                  dirty: !!draft.sid, base: draft.base, sid: draft.sid || undefined,
                })}>
                  <span className="mm-tpl__art is-draft" aria-hidden><MiniSystem thumb={thumbOf(draft.map)} size={104} /></span>
                  <b>{t('mm.tpl.draft.t', { name: draft.map.name })}</b><span>{tn('mm.tpl.draft.d', draft.map.bodies.length)}</span>
                </button>
              )}
            </div>

            <section className="mm-gen">
              <div className="mm-gen__head"><b>{t('mm.gen.title')}</b><span className="mm-note">{t('mm.gen.note')}</span></div>
              <div className="mm-gen__grid">
                {slider('planets', t('mm.gen.planets'), 2, 14, 1, v => String(v))}
                {slider('moonsMax', t('mm.gen.moons'), 0, 6, 1, v => `0–${v}`)}
                {slider('belts', t('mm.gen.belts'), 0, 3, 1, v => String(v))}
                {slider('richness', t('mm.gen.richness'), 0.4, 2.5, 0.1, v => t(v < 0.8 ? 'mm.gen.lean' : v < 1.3 ? 'mm.gen.fair' : v < 1.9 ? 'mm.gen.generous' : 'mm.gen.lavish'))}
                {slider('starts', t('mm.gen.starts'), 2, 10, 1, v => String(v))}
                {slider('spread', t('mm.gen.spread'), 0.6, 1.6, 0.05, v => t(v < 0.85 ? 'mm.gen.tight' : v < 1.2 ? 'mm.gen.even' : 'mm.gen.wide'))}
              </div>
              <div className="mm-row mm-row--wrap">
                <span className="mm-field__l">{t('mm.gen.theme')}</span>
                {NAME_THEMES.map(th => <button key={th} className={`mm-chip${gen.theme === th ? ' is-on' : ''}`} onClick={() => setGen({ ...gen, theme: th })}>{themeLabel(th)}</button>)}
                <span className="mm-top__fill" />
                <span className="mm-mono">{t('mm.gen.seed', { n: gen.seed })}</span>
                <button className="mm-btn is-primary" onClick={roll}>{t('mm.gen.roll')}</button>
              </div>
            </section>
          </div>

          <aside className="mm-start__side">
            <div className="mm-sec">{t('mm.start.yourMaps')}</div>
            {maps === null && !error && <p className="mm-note">{t('mm.loading')}</p>}
            {maps?.length === 0 && <p className="mm-note">{t('mm.start.noMaps')}</p>}
            {maps?.map(s => (
              <div key={s.id} className="mm-mapcard">
                <button className="mm-mapcard__open" onClick={() => open(s.id)}>
                  <span className="mm-mapcard__art" style={{ background: `radial-gradient(circle, ${s.sun_color} 0 6px, #101a26 7px)` }} aria-hidden />
                  <span className="mm-mapcard__t">
                    <b>{s.name}</b>
                    <span className="mm-mono">
                      {[tn('mm.n.bodies', s.bodies), new Date(s.updated_ms).toLocaleDateString(getLang()), ...(s.hosted_count ? [t('mm.hosted', { n: s.hosted_count })] : [])].join(' · ')}
                    </span>
                  </span>
                  {s.published && <span className="mm-tag is-pub">{t('mm.start.published')}</span>}
                  <span className={`mm-tag ${s.blockers ? 'is-bad' : 'is-ok'}`}>{s.blockers ? tn('mm.start.blockers', s.blockers) : t('mm.start.ready')}</span>
                </button>
                <button className="mm-icon" aria-label={t('mm.start.deleteAria', { name: s.name })} onClick={() => remove(s)}>✕</button>
              </div>
            ))}
            <div className="mm-gold-note">{tMarkup('mm.start.holders', { name: t('hangar.commissionName') })}</div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** First visit only: three short tips over the map. */
function Coach({ touch, onDone }: { touch: boolean; onDone: () => void }) {
  useI18n();
  const kind = touch ? 'touch' : 'mouse';
  const steps = [1, 2, 3].map(n => [t(`mm.coach.${kind}${n}.t` as Key), t(`mm.coach.${kind}${n}.d` as Key)]);
  const [i, setI] = useState(0);
  return (
    <div className="mm-coach" role="dialog" aria-label={t('mm.coach.aria')}>
      <span className="mm-mono">{t('mm.coach.step', { i: i + 1, n: steps.length })}</span>
      <b>{steps[i][0]}</b>
      <p>{steps[i][1]}</p>
      <div className="mm-row mm-row--end">
        <button className="mm-btn is-small" onClick={onDone}>{t('mm.coach.skip')}</button>
        {i < steps.length - 1
          ? <button className="mm-btn is-small is-primary" onClick={() => setI(i + 1)}>{t('mm.coach.next')}</button>
          : <button className="mm-btn is-small is-primary" onClick={onDone}>{t('mm.coach.go')}</button>}
      </div>
    </div>
  );
}

type SaveState = 'fresh' | 'saved' | 'unsaved' | 'saving' | 'error';
/** States that hold changes the server does not have. */
const DIRTY: ReadonlySet<SaveState> = new Set<SaveState>(['unsaved', 'saving', 'error']);
/** Autosave waits this long after the last edit. */
const AUTOSAVE_MS = 3000;
/** The draft is written this long after the last edit (and at once on exit). */
const DRAFT_MS = 1000;

/** What the workshop opens with besides the map itself. */
type OpenOpts = { dirty?: boolean; base?: number | null; sid?: string };

/** A sector edge dragged to `orbit`. A shared edge (two bands touching)
 *  moves both bands; a free edge stops at its neighbour. Neither crosses
 *  a band's own other edge. Null when the sector is gone. */
function edgeMoved(m: CustomMap, id: string, which: 'inner' | 'outer', orbit: number): CustomMap | null {
  const i = m.sectors.findIndex(x => x.id === id);
  const sct = m.sectors[i];
  if (!sct) return null;
  const prev = m.sectors[i - 1], next = m.sectors[i + 1];
  if (which === 'inner') {
    const shared = !!prev && prev.outer === sct.inner;
    const lo = shared ? prev.inner + 10 : (prev?.outer ?? 0);
    const v = Math.max(lo, Math.min(sct.outer - 10, orbit));
    return { ...m, sectors: m.sectors.map(x => (x.id === id ? { ...x, inner: v } : shared && x.id === prev!.id ? { ...x, outer: v } : x)) };
  }
  const shared = !!next && next.inner === sct.outer;
  const hi = shared ? next.outer - 10 : (next?.inner ?? 15400);
  const v = Math.max(sct.inner + 10, Math.min(hi, orbit));
  return { ...m, sectors: m.sectors.map(x => (x.id === id ? { ...x, outer: v } : shared && x.id === next!.id ? { ...x, inner: v } : x)) };
}

const same = (a: CustomMap, b: CustomMap) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The workshop: the map, the tools, the inspector. (Exported for its
 *  save tests.) */
export function Workshop({ initial, initialId, opts, onExit }: { initial: CustomMap; initialId: string | null; opts: OpenOpts; onExit: () => void }) {
  useI18n();
  const mobile = useIsMobile();
  // The history lives in a ref as well as in state, so an edit knows at
  // once whether it changed anything: a no-op is no undo step, and does
  // not mark the map unsaved (a focus and blur on a fresh template must
  // not autosave it into "Your maps").
  const histRef = useRef<Hist>({ past: [], present: initial, future: [] });
  const [hist, setHistState] = useState<Hist>(histRef.current);
  const putHist = useCallback((h: Hist) => { histRef.current = h; setHistState(h); }, []);
  /** The map before a live edit (typing, a slider, a drag) began. */
  const pending = useRef<CustomMap | null>(null);
  /** A world or a sector edge is being dragged on the map right now. */
  const dragging = useRef(false);
  /** Bumped by every change; savedVersion is the one the server has. */
  const version = useRef(0);
  const savedVersion = useRef(opts.dirty ? -1 : 0);
  const map = hist.present;
  const [mapId, setMapId] = useState<string | null>(initialId);
  const idRef = useRef(mapId);
  /** The server's updated_ms for the version this editor builds on. */
  const baseRef = useRef<number | null>(opts.base ?? null);
  const sid = useMemo(() => opts.sid || Math.random().toString(36).slice(2), [opts.sid]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [canHost, setCanHost] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool | null>(null);
  const [symmetry, setSymmetry] = useState(1);
  const [ringCount, setRingCount] = useState(4);
  const [ringType, setRingType] = useState<MapBodyType>('dwarf');
  const [theme, setTheme] = useState('Mythic');
  const [scale, setScale] = useState<Scale>('compressed');
  const [preview, setPreview] = useState(false);
  const [lensOn, setLensOn] = useState(false);
  const [lensOpen, setLensOpen] = useState(() => !window.matchMedia?.('(max-width: 1023px)').matches);
  const [picking, setPicking] = useState<{ aspects: Set<MatchAspect>; ids: string[] } | null>(null);
  const [fit, setFit] = useState(0);
  const [showCheck, setShowCheck] = useState(false);
  const [showHost, setShowHost] = useState(false);
  // 'fresh': a template or a roll nobody has touched yet. It is not
  // autosaved, so browsing templates never fills your map list.
  const [saveState, setSaveState] = useState<SaveState>(opts.dirty ? 'unsaved' : initialId ? 'saved' : 'fresh');
  const [saveError, setSaveError] = useState<string | null>(null);
  /** A word about a save the player should know of (a conflict copy). */
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped to re-arm the autosave after a save that edits overtook. */
  const [kick, setKick] = useState(0);
  const [treeQ, setTreeQ] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [coach, setCoach] = useState(() => !coached());
  // phone sheets
  const [sheet, setSheet] = useState<'peek' | 'full'>('peek');
  const [palOpen, setPalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mapSheet, setMapSheet] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  const issues = useMemo(() => checkMap(map), [map]);
  const blockers = issues.filter(i => i.level === 'block').length;
  const warnings = issues.filter(i => i.level === 'warn').length;
  const lens = useMemo(() => (lensOn ? fairness(map) : null), [lensOn, map]);

  useEffect(() => {
    apiFetch<{ maps: Summary[]; can_host: boolean }>('/api/maps').then(res => {
      if (res.ok) {
        setCanHost(res.data.can_host);
        // A save that answered first knows better.
        if (initialId) setSummary(prev => prev ?? res.data.maps.find(m => m.id === initialId) ?? null);
      }
    });
  }, [initialId]);

  const isDirty = useCallback(() => version.current !== savedVersion.current, []);
  const writeDraft = useCallback(() => {
    saveDraft({ map: histRef.current.present, id: idRef.current, base: baseRef.current, sid });
  }, [sid]);
  // The draft follows unsaved changes (only those), a second behind.
  useEffect(() => {
    if (!DIRTY.has(saveState)) return;
    const timer = window.setTimeout(writeDraft, DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [map, saveState, writeDraft]);
  // ...and is written at once when the workshop goes with changes unsaved.
  useEffect(() => () => { if (isDirty()) writeDraft(); }, [isDirty, writeDraft]);
  // Closing the tab with changes unsaved asks first.
  useEffect(() => {
    if (!DIRTY.has(saveState)) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      writeDraft();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [saveState, writeDraft]);

  const touched = useCallback(() => { version.current++; setSaveState('unsaved'); }, []);
  /** A committed edit: the old map goes on the undo stack. */
  const commit = useCallback((next: CustomMap, select?: string[]) => {
    const h = histRef.current;
    const base = pending.current ?? h.present;
    const live = pending.current !== null;
    pending.current = null;
    if (select) setSelection(new Set(select));
    if (same(base, next)) {
      // Nothing changed. A live edit that came back to where it began
      // just shows the map as it was.
      if (live && h.present !== next) putHist({ ...h, present: next });
      return;
    }
    putHist({ past: [...h.past.slice(-99), base], present: next, future: [] });
    touched();
  }, [putHist, touched]);
  /** A live edit mid-drag, mid-slide or mid-typing: shown, not yet an
   *  undo step. */
  const transient = useCallback((next: CustomMap) => {
    const h = histRef.current;
    if (!pending.current) pending.current = h.present;
    putHist({ ...h, present: next });
    touched();
  }, [putHist, touched]);
  /** Fold a live edit whose commit will never come (its field went away
   *  before it blurred) into the history as one undo step. */
  const flushPending = useCallback(() => {
    const base = pending.current;
    if (!base || dragging.current) return;
    pending.current = null;
    const h = histRef.current;
    if (same(base, h.present)) return;
    putHist({ past: [...h.past.slice(-99), base], present: h.present, future: [] });
  }, [putHist]);
  /** The name field, cleaned on blur. Cleared, it takes the default name
   *  in the player's language ("Sistema sem nome"), not the cleaner's. */
  const commitName = () => {
    const m = histRef.current.present;
    commit(normalizeMap({ ...m, name: m.name.trim() || t('mm.name.untitled') }));
  };
  const undo = useCallback(() => {
    if (dragging.current) return;
    flushPending();
    const h = histRef.current;
    if (!h.past.length) return;
    putHist({ past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] });
    touched();
  }, [flushPending, putHist, touched]);
  const redo = useCallback(() => {
    if (dragging.current) return;
    flushPending();
    const h = histRef.current;
    if (!h.future.length) return;
    putHist({ past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) });
    touched();
  }, [flushPending, putHist, touched]);

  const summaryRef = useRef<Summary | null>(null);
  summaryRef.current = summary ?? summaryRef.current;
  const inflight = useRef<Promise<Summary | null> | null>(null);
  /** One save to the server. A map deleted elsewhere (404) is saved as a
   *  new map; one saved elsewhere since it was opened ('stale') is never
   *  written over: this version becomes a new map, "X (conflict)". */
  const saveOnce = useCallback(async (): Promise<Summary | null> => {
    const v = version.current;
    const prevId = idRef.current;
    // Nothing new since the last save: its answer stands.
    if (v === savedVersion.current && prevId && summaryRef.current) return summaryRef.current;
    setSaveState('saving'); setSaveError(null);
    const m = normalizeMap(histRef.current.present);
    type Saved = { map: CustomMap; summary: Summary };
    const post = (mm: CustomMap) => apiFetch<Saved>('/api/maps', { method: 'POST', body: JSON.stringify({ map: mm }) });
    let sent = m;
    let asNew = !prevId;
    let res = prevId
      ? await apiFetch<Saved>(`/api/maps/${prevId}`, {
        method: 'PUT', body: JSON.stringify({ map: m, ...(baseRef.current != null ? { base_updated_ms: baseRef.current } : {}) }),
      })
      : await post(m);
    let conflict = false;
    if (!res.ok && prevId && res.status === 404) {
      res = await post(m);
      asNew = true;
    } else if (!res.ok && prevId && res.error?.code === 'stale') {
      sent = normalizeMap({ ...m, name: t('mm.name.conflict', { name: m.name }) });
      res = await post(sent);
      asNew = true;
      conflict = res.ok;
    }
    if (!res.ok) {
      setSaveState('error');
      setSaveError(mapApiError(res.error, 'mm.save.failed'));
      return null;
    }
    const s = res.data.summary;
    idRef.current = s.id;
    setMapId(s.id);
    baseRef.current = s.updated_ms ?? null;
    const merged = asNew ? s : { ...(summaryRef.current ?? {}), ...s };
    summaryRef.current = merged;
    setSummary(merged);
    if (conflict) {
      // The workshop now edits the new map: show its name.
      const h = histRef.current;
      putHist({ ...h, present: { ...h.present, name: sent.name } });
      setNotice(t('mm.save.conflict', { name: sent.name }));
    }
    savedVersion.current = v;
    if (version.current === v) {
      setSaveState('saved');
      clearDraft(sid, s.id);
    } else {
      // Edited while it saved: go round again.
      setSaveState('unsaved');
      setKick(k => k + 1);
    }
    return merged;
  }, [putHist, sid]);
  /** Save. One at a time: a save asked for during another (the autosave,
   *  Host, Publish) waits for it, then saves whatever is new since. */
  const save = useCallback(async (): Promise<Summary | null> => {
    while (inflight.current) await inflight.current;
    const p = saveOnce();
    inflight.current = p;
    try { return await p; } finally { if (inflight.current === p) inflight.current = null; }
  }, [saveOnce]);

  // Autosave: a few seconds after the last edit, never mid-drag (the
  // drag's end is an edit, and re-arms it).
  useEffect(() => {
    if (saveState !== 'unsaved' || map.bodies.length === 0) return;
    const timer = window.setTimeout(() => { if (!dragging.current) void save(); }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [map, saveState, save, kick]);

  /** Back to the start screen: save first; if that fails, ask. */
  const exiting = useRef(false);
  const exit = async () => {
    if (exiting.current) return;
    exiting.current = true;
    flushPending();
    if (isDirty() && histRef.current.present.bodies.length > 0) {
      const s = await save();
      if (!s && !window.confirm(t('mm.exit.confirm'))) { exiting.current = false; return; }
    }
    onExit();
  };

  // Keyboard: undo/redo, delete, duplicate, select all, Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(new Set(map.bodies.map(b => b.id))); }
      else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const ids = [...selection].filter(id => id !== 'sun');
        if (ids.length) { const r = duplicateBodies(map, ids, theme); commit(r.map, r.ids); }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const secs = [...selection].filter(id => id.startsWith('sector:')).map(id => id.slice(7));
        const ids = [...selection].filter(id => id !== 'sun' && !id.startsWith('sector:'));
        if (ids.length || secs.length) commit(deleteSectors(deleteBodies(map, ids), secs), []);
      } else if (e.key === 'Escape') { setTool(null); setPicking(null); setSelection(new Set()); setShowCheck(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [map, selection, theme, commit, undo, redo, save]);

  const onSelect = (ids: string[], mode: 'replace' | 'toggle' | 'add') => {
    setSelection(prev => {
      if (mode === 'replace') return new Set(ids);
      const next = new Set(prev);
      for (const id of ids) {
        if (mode === 'toggle' && next.has(id)) next.delete(id); else next.add(id);
      }
      return next;
    });
    if (ids.length) { setMapSheet(false); setSheet('peek'); }
  };
  const onPlace = (tl: Tool, parent: string, orbit: number, angle: number) => {
    if (tl === 'sector') return;
    const r = tl === 'ring' ? ringOf(map, ringType, ringCount, orbit, angle, theme)
      : parent !== 'sun' || tl === 'belt' || tl === 'moon' || tl === 'scatter' ? placeBody(map, tl as Exclude<Tool, 'scatter' | 'ring' | 'sector'>, parent, orbit, angle, theme)
        : placeSymmetric(map, tl as Exclude<Tool, 'scatter' | 'ring' | 'sector'>, orbit, angle, theme, symmetry);
    commit(r.map, r.ids);
  };
  const onScatter = (pts: Array<{ orbit: number; angle: number }>) => {
    const r = scatterAsteroids(map, pts, theme);
    commit(r.map, r.ids);
  };
  /** A world dragged: built from the map as it was before the drag, so
   *  the end lands exactly where the pointer left it. */
  const onMove = (id: string, orbit: number, angle: number, phase: 'start' | 'move' | 'end') => {
    const base = pending.current ?? histRef.current.present;
    const next = normalizeMap({ ...base, bodies: base.bodies.map(b => (b.id === id ? { ...b, orbit, angle } : b)) });
    if (phase === 'end') { dragging.current = false; commit(next); return; }
    dragging.current = true;
    transient(next);
  };
  const onPick = (srcId: string) => {
    if (!picking) return;
    commit(matchBodies(map, srcId, picking.ids, picking.aspects), picking.ids);
    setPicking(null);
  };
  const pickTool = (tl: Tool) => { setTool(tool === tl ? null : tl); setPalOpen(false); setPicking(null); };

  const selIds = [...selection].filter(id => id === 'sun' || map.bodies.some(b => b.id === id)
    || (id.startsWith('sector:') && map.sectors.some(x => `sector:${x.id}` === id)));
  const single = selIds.length === 1 ? selIds[0] : null;
  const singleSector = single?.startsWith('sector:') ? map.sectors.find(x => `sector:${x.id}` === single) ?? null : null;
  const singleBody = single && single !== 'sun' && !singleSector ? map.bodies.find(b => b.id === single) ?? null : null;
  const bulkIds = selIds.filter(id => id !== 'sun' && !id.startsWith('sector:'));
  const onSectorDraw = (inner: number, outer: number) => {
    const r = addSector(map, inner, outer);
    if (r.id) { commit(r.map, [`sector:${r.id}`]); setTool(null); setMapSheet(false); setSheet('peek'); }
  };
  const onSectorEdge = (id: string, which: 'inner' | 'outer', orbit: number, phase: 'move' | 'end') => {
    const base = pending.current ?? histRef.current.present;
    const next = edgeMoved(base, id, which, orbit);
    if (phase === 'end') {
      dragging.current = false;
      commit(next ? normalizeMap(next) : histRef.current.present, [`sector:${id}`]);
      return;
    }
    if (!next) return;
    dragging.current = true;
    transient(next);
  };

  // Whatever the inspector shows. When it changes (a new selection, the
  // phone sheet shut), a live edit in the old one is folded into the
  // history: its field unmounted before it could blur and commit.
  const showSheet = selIds.length > 0 || mapSheet;
  const inspectorKey = `${mobile && !showSheet ? 'shut:' : ''}${singleSector ? `sector:${singleSector.id}` : single === 'sun' ? 'sun' : singleBody ? `body:${singleBody.id}` : bulkIds.length > 1 ? 'bulk' : 'map'}`;
  useEffect(() => { flushPending(); }, [inspectorKey, flushPending]);

  // The tree: the sun's worlds in orbit order, each with its moons.
  const tree = useMemo(() => {
    const q = treeQ.trim().toLowerCase();
    const sunKids = map.bodies.filter(b => b.parent === 'sun').sort((a, b) => a.orbit - b.orbit);
    const rows: Array<{ id: string; name: string; color: string; depth: number; tag: string; moons: number; head?: boolean }> = [];
    let lastSector: string | null | undefined;
    for (const b of sunKids) {
      const moons = map.bodies.filter(x => x.parent === b.id).sort((a, c) => a.orbit - c.orbit);
      const hitMoons = q ? moons.filter(m => m.name.toLowerCase().includes(q)) : moons;
      if (q && !b.name.toLowerCase().includes(q) && !hitMoons.length) continue;
      if (map.sectors.length) {
        const sct = sectorOf(map, b);
        if ((sct?.id ?? null) !== lastSector) {
          lastSector = sct?.id ?? null;
          rows.push({ id: sct ? `sector:${sct.id}` : `loose:${b.id}`, name: sct ? sct.name : '', color: sct?.color ?? '#8fa6ba', depth: 0, tag: '', moons: 0, head: true });
        }
      }
      rows.push({ id: b.id, name: b.name, color: b.color, depth: 0, tag: b.start ? '✦' : b.secret ? '?' : b.type === 'asteroid' ? '·' : '', moons: moons.length });
      if (folded.has(b.id) && !q) continue;
      for (const m of hitMoons) rows.push({ id: m.id, name: m.name, color: m.color, depth: 1, tag: m.start ? '✦' : m.secret ? '?' : '', moons: 0 });
    }
    return rows;
  }, [map, treeQ, folded]);
  const fold = (id: string) => setFolded(f => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const status = blockers ? tn('mm.status.blockers', blockers) : warnings ? tn('mm.status.warnings', warnings) : t('mm.status.ready');
  const statusCls = blockers ? ' is-bad' : warnings ? ' is-warn' : ' is-ok';
  const saveLabel = t(saveState === 'saving' ? 'mm.save.saving' : saveState === 'saved' ? 'mm.save.saved' : saveState === 'error' ? 'mm.save.retry' : 'mm.save.save');
  const hint = (base: string) => t(touchKey(base, mobile));
  const toolHint = picking
    ? hint('mm.hint.pick')
    : tool === 'scatter' ? t('mm.hint.scatter')
      : tool === 'ring' ? hint('mm.hint.ring')
      : tool === 'sector' ? hint('mm.hint.sector')
        : tool === 'moon' ? hint('mm.hint.moon')
          : tool === 'belt' ? hint('mm.hint.belt')
            : tool ? (symmetry > 1 ? t('mm.hint.withSym', { hint: hint('mm.hint.place'), n: symmetry }) : hint('mm.hint.place')) : null;

  const tools = (
    <>
      <div className="mm-sec">{mobile ? t('mm.tools.worlds') : t('mm.tools.pickThenClick')}</div>
      <div className="mm-pal">
        {PALETTE.map(p => (
          <button key={p} className={`mm-pal__btn${tool === p ? ' is-on' : ''}`} onClick={() => pickTool(p)} aria-pressed={tool === p}>
            <PaletteIcon tool={p} />
            <span>{typeLabel(p)}</span>
          </button>
        ))}
      </div>
      <div className="mm-sec">{t('mm.tools.paint')}</div>
      <div className="mm-pal is-paint">
        <button className={`mm-pal__btn${tool === 'scatter' ? ' is-on' : ''}`} onClick={() => pickTool('scatter')} aria-pressed={tool === 'scatter'}>
          <PaletteIcon tool="scatter" /><span>{t('mm.tools.spray')}</span>
        </button>
        <button className={`mm-pal__btn${tool === 'ring' ? ' is-on' : ''}`} onClick={() => pickTool('ring')} aria-pressed={tool === 'ring'}>
          <PaletteIcon tool="ring" /><span>{t('mm.tools.ring')}</span>
        </button>
        <button className={`mm-pal__btn is-wide${tool === 'sector' ? ' is-on' : ''}`} onClick={() => pickTool('sector')} aria-pressed={tool === 'sector'}>
          <PaletteIcon tool="sector" /><span>{t('mm.tools.sector')}</span>
        </button>
      </div>
      {tool === 'ring' && (
        <div className="mm-box is-tight">
          <div className="mm-row mm-row--wrap">
            <span className="mm-field__l">{t('mm.tools.howMany')}</span>
            <Stepper label={t('mm.tools.ringCount')} value={ringCount} min={2} max={12} onChange={setRingCount} />
          </div>
          <div className="mm-row mm-row--wrap">
            {RING_TYPES.map(ty => <button key={ty} className={`mm-chip is-small${ringType === ty ? ' is-on' : ''}`} onClick={() => setRingType(ty)}>{typeLabel(ty)}</button>)}
          </div>
        </div>
      )}
      <div className="mm-sec mm-sec--row"><span>{t('mm.tools.symmetry')}</span><span className="mm-mono">{symmetry > 1 ? t('mm.tools.ways', { n: symmetry }) : t('mm.tools.off')}</span></div>
      <div className="mm-sym" role="radiogroup" aria-label={t('mm.tools.symmetryAria')}>
        {SYMMETRY.map(n => (
          <button key={n} role="radio" aria-checked={symmetry === n} className={`mm-chip is-small${symmetry === n ? ' is-on' : ''}`} onClick={() => setSymmetry(n)}>
            {n === 1 ? t('mm.tools.offChip') : `×${n}`}
          </button>
        ))}
      </div>
      <div className="mm-row mm-row--wrap">
        <span className="mm-field__l">{t('mm.tools.newNames')}</span>
        <select className="mm-input is-small" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label={t('mm.tools.themeAria')}>
          {NAME_THEMES.map(th => <option key={th} value={th}>{themeLabel(th)}</option>)}
        </select>
      </div>
    </>
  );

  const treeView = (
    <>
      <div className="mm-sec">{tn('mm.tree.title', map.bodies.length)}</div>
      <input className="mm-input is-small mm-tree__q" placeholder={t('mm.tree.find')} value={treeQ} onChange={(e) => setTreeQ(e.target.value)} aria-label={t('mm.tree.find')} />
      <div className="mm-tree">
        <button className={`mm-tree__row${selection.has('sun') ? ' is-sel' : ''}`} onClick={(e) => { onSelect(['sun'], e.shiftKey ? 'toggle' : 'replace'); setListOpen(false); }}>
          <span className="mm-dot" style={{ background: map.sun.color }} />{map.sun.name}<span className="mm-tree__tag">{t('mm.tree.sun')}</span>
        </button>
        {tree.map(r => (r.head ? (
          r.id.startsWith('sector:')
            ? (
              <button key={r.id} className={`mm-tree__head${selection.has(r.id) ? ' is-sel' : ''}`} style={{ color: r.color }} onClick={() => { onSelect([r.id], 'replace'); setListOpen(false); }}>
                {r.name.toUpperCase()}
              </button>
            )
            : <div key={r.id} className="mm-tree__head is-loose">{t('mm.tree.loose').toUpperCase()}</div>
        ) : (
          <div key={r.id} className="mm-tree__line" style={{ paddingLeft: r.depth * 16 }}>
            {r.depth === 0 && r.moons > 0
              ? <button className="mm-tree__fold" aria-label={folded.has(r.id) ? t('mm.tree.showMoons') : t('mm.tree.hideMoons')} onClick={() => fold(r.id)}>{folded.has(r.id) ? '▸' : '▾'}</button>
              : <span className="mm-tree__fold" />}
            <button className={`mm-tree__row${selection.has(r.id) ? ' is-sel' : ''}`}
              onClick={(e) => { onSelect([r.id], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace'); setListOpen(false); }}>
              <span className="mm-dot" style={{ background: r.color }} />{r.name}
              {r.moons > 0 && folded.has(r.id) && <span className="mm-mono"> +{r.moons}</span>}
              <span className="mm-tree__tag">{r.tag}</span>
            </button>
          </div>
        )))}
      </div>
    </>
  );

  const inspector = singleSector
    ? <SectorInspector key={singleSector.id} map={map} sector={singleSector} onChange={commit} onTransient={transient} onSelectWorlds={(ids) => setSelection(new Set(ids))} />
    : single === 'sun'
    ? <SunInspector map={map} onChange={commit} onTransient={transient} />
    : singleBody
      ? <BodyInspector key={singleBody.id} map={map} body={singleBody} theme={theme} onChange={commit} onTransient={transient} />
      : bulkIds.length > 1 && mobile
        ? <BulkBar compact map={map} ids={bulkIds} theme={theme} onChange={commit} onClear={() => setSelection(new Set())} onMatch={(a) => { setPicking({ aspects: a, ids: bulkIds }); setTool(null); }} />
        : bulkIds.length > 1
          ? <div className="mm-insp"><div className="mm-insp__body"><div className="mm-sec">{t('mm.sel.count', { n: bulkIds.length })}</div><p className="mm-note">{t('mm.sel.note')}</p></div></div>
          : <MapInspector map={map} theme={theme} touch={mobile} onChange={commit} onTransient={transient}
            onDrawSector={() => { setTool('sector'); setMapSheet(false); setPicking(null); }}
            onPickSector={(id) => { setSelection(new Set([`sector:${id}`])); setMapSheet(false); setSheet('peek'); }} />;

  const lensPanel = lens && (
    <div className={`mm-lenspanel${lensOpen ? '' : ' is-folded'}`}>
      <button className="mm-lenspanel__head" onClick={() => setLensOpen(o => !o)} aria-expanded={lensOpen}>
        <b>{t('mm.lens.title')}</b>
        <span className={`mm-tag ${lens.score >= 80 ? 'is-ok' : lens.score >= 55 ? 'is-warn' : 'is-bad'}`}>{lens.score}%</span>
        <span className="mm-mono">{lensOpen ? '▾' : '▸'} {tn('mm.n.starts', lens.starts.length)}</span>
      </button>
      {lensOpen && <p className="mm-note">{t('mm.lens.note')}</p>}
      {lensOpen && [...lens.starts].sort((a, b) => b.total - a.total).map(s => (
        <button key={s.id} className="mm-lensrow" onClick={() => onSelect([s.id], 'replace')}>
          <span className="mm-dot" style={{ background: s.color }} />
          <span className="mm-lensrow__n">{s.name}</span>
          <span className="mm-mono">{s.metal}·{s.credits}·{s.science}</span>
          <span className="mm-lensrow__bar"><span style={{ width: `${(s.total / Math.max(1, ...lens.starts.map(x => x.total))) * 100}%`, background: s.color }} /></span>
        </button>
      ))}
      {lensOpen && <span className="mm-mono">{t('mm.lens.key')}</span>}
    </div>
  );
  const noLens = lensOn && !lens;

  const stage = (
    <main className={`mm-stage is-${map.settings.backdrop}`}>
      <MapView
        map={map} scale={scale} selection={selection} tool={tool} preview={preview} fitSignal={fit}
        touch={mobile} symmetry={symmetry} ringCount={ringCount} lens={lens} picking={!!picking}
        onSelect={onSelect} onPlace={onPlace} onScatter={onScatter} onMove={onMove} onPick={onPick}
        onSectorDraw={onSectorDraw} onSectorEdge={onSectorEdge}
        onCancelTool={() => { setTool(null); setPicking(null); }}
      />
      {!mobile && (
        <div className="mm-stage__ctl">
          <button className={`mm-btn is-small${scale === 'true' ? ' is-on' : ''}`} onClick={() => setScale(scale === 'compressed' ? 'true' : 'compressed')}>
            {scale === 'compressed' ? t('mm.stage.compressed') : t('mm.stage.true')}
          </button>
          <button className="mm-btn is-small" onClick={() => setFit(f => f + 1)}>{t('mm.stage.fit')}</button>
          <button className={`mm-btn is-small${lensOn ? ' is-on' : ''}`} onClick={() => setLensOn(l => !l)}>{t('mm.stage.lens')}</button>
        </div>
      )}
      {toolHint && (
        <div className="mm-toolhint">
          <span>{toolHint}</span>
          {tool === 'ring' && <Stepper label={t('mm.tools.ringCount')} value={ringCount} min={2} max={12} onChange={setRingCount} />}
          <button className="mm-btn is-small is-primary" onClick={() => { setTool(null); setPicking(null); }}>{picking ? t('mm.cancel') : t('mm.done')}</button>
        </div>
      )}
      {lensPanel}
      {noLens && <div className="mm-lenspanel"><p className="mm-note">{t('mm.lens.needTwo')}</p></div>}
      {!mobile && <div className="mm-stage__hint mm-mono">{t('mm.stage.help')}</div>}
      {showCheck && <Checklist issues={issues} onShow={(ids) => { setSelection(new Set(ids)); setShowCheck(false); setSheet('peek'); }} onClose={() => setShowCheck(false)} />}
      {!mobile && bulkIds.length > 1 && !picking && (
        <BulkBar map={map} ids={bulkIds} theme={theme} onChange={commit} onClear={() => setSelection(new Set())} onMatch={(a) => { setPicking({ aspects: a, ids: bulkIds }); setTool(null); }} />
      )}
      {coach && <Coach touch={mobile} onDone={() => { setCoach(false); markCoached(); }} />}
    </main>
  );

  const noticeBanner = notice && (
    <div className="mm-banner is-note" role="status">
      <span>{notice}</span>
      <button className="mm-icon is-small" aria-label={t('mm.close')} onClick={() => setNotice(null)}>✕</button>
    </div>
  );

  const hostPanel = showHost && (
    <HostPanel
      map={map} summary={summary} canHost={canHost} onSaveFirst={save}
      onToggleSecrets={(on) => commit({ ...map, settings: { ...map.settings, shareHidesSecrets: on } })}
      onPublished={(s) => setSummary(s)}
      onEditPitch={() => { setShowHost(false); setSelection(new Set()); setMapSheet(true); setSheet('full'); }}
      onClose={() => setShowHost(false)}
    />
  );

  if (mobile) {
    return (
      <div className="mm-work is-mobile">
        <header className="mm-top">
          <button className="mm-icon" aria-label={t('mm.backToMaps')} onClick={exit}>‹</button>
          <input className="mm-top__mname" value={map.name} maxLength={40} aria-label={t('mm.mapName')}
            onChange={(e) => transient({ ...map, name: e.target.value })} onBlur={commitName} />
          <button className="mm-icon" aria-label={t('mm.undo')} disabled={!hist.past.length} onClick={undo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></svg>
          </button>
          <button className="mm-icon" aria-label={t('mm.redo')} disabled={!hist.future.length} onClick={redo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></svg>
          </button>
          <button className={`mm-status is-dot${statusCls}`} aria-label={status} onClick={() => setShowCheck(s => !s)}>{blockers ? '✕' : warnings ? '!' : '✓'}</button>
          <button className="mm-icon" aria-label={t('mm.mob.more')} onClick={() => setMenuOpen(true)}>⋯</button>
        </header>
        {saveError && <div className="mm-banner is-bad">{saveError}</div>}
        {noticeBanner}
        <div className="mm-work__body">{stage}</div>

        {!tool && !picking && (
          <>
            <button className="mm-fab" aria-label={t('mm.mob.add')} onClick={() => setPalOpen(true)}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            {!showSheet && <button className="mm-fab is-left" aria-label={t('mm.mob.wholeMap')} onClick={() => { setMapSheet(true); setSheet('full'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M14 6l4 4" /></svg>
            </button>}
          </>
        )}

        {showSheet && !tool && !picking && (
          <div className={`mm-sheet is-${sheet}`}>
            <div className="mm-sheet__bar">
              <button className="mm-sheet__grip" aria-label={sheet === 'peek' ? t('mm.mob.expand') : t('mm.mob.shrink')} onClick={() => setSheet(sheet === 'peek' ? 'full' : 'peek')} />
              <button className="mm-icon" aria-label={t('mm.close')} onClick={() => { setSelection(new Set()); setMapSheet(false); }}>✕</button>
            </div>
            <div className="mm-sheet__body" onFocus={(e) => { if (typesText(e.target)) setSheet('full'); }}>{inspector}</div>
          </div>
        )}

        {palOpen && (
          <div className="mm-scrim" onClick={() => setPalOpen(false)}>
            <div className="mm-sheet is-full is-pal" onClick={(e) => e.stopPropagation()}>
              <div className="mm-sheet__bar"><b>{t('mm.mob.add')}</b><button className="mm-icon" aria-label={t('mm.close')} onClick={() => setPalOpen(false)}>✕</button></div>
              <div className="mm-sheet__body mm-rail is-sheet">{tools}</div>
            </div>
          </div>
        )}
        {listOpen && (
          <div className="mm-scrim" onClick={() => setListOpen(false)}>
            <div className="mm-sheet is-full" onClick={(e) => e.stopPropagation()}>
              <div className="mm-sheet__bar"><b>{t('mm.mob.everyWorld')}</b><button className="mm-icon" aria-label={t('mm.close')} onClick={() => setListOpen(false)}>✕</button></div>
              <div className="mm-sheet__body mm-rail is-sheet">{treeView}</div>
            </div>
          </div>
        )}
        {menuOpen && (
          <div className="mm-scrim" onClick={() => setMenuOpen(false)}>
            <div className="mm-menu" onClick={(e) => e.stopPropagation()} role="menu">
              <button role="menuitem" onClick={() => { save(); setMenuOpen(false); }}>{saveLabel}{saveState === 'saved' ? ' ✓' : ''}</button>
              <button role="menuitem" className="is-gold" onClick={() => { setShowHost(true); setMenuOpen(false); }}>{t('mm.mob.shareAll')}</button>
              <button role="menuitem" onClick={() => { setListOpen(true); setMenuOpen(false); }}>{t('mm.mob.everyWorldN', { n: map.bodies.length })}</button>
              <button role="menuitem" onClick={() => { setLensOn(l => !l); setMenuOpen(false); }}>{lensOn ? t('mm.mob.lensHide') : t('mm.mob.lensShow')}</button>
              <button role="menuitem" onClick={() => { setPreview(p => !p); setMenuOpen(false); }}>{preview ? t('mm.stage.stop') : t('mm.stage.preview')}</button>
              <button role="menuitem" onClick={() => { setScale(scale === 'compressed' ? 'true' : 'compressed'); setMenuOpen(false); }}>{scale === 'compressed' ? t('mm.stage.true') : t('mm.stage.compressed')}</button>
              <button role="menuitem" onClick={() => { setFit(f => f + 1); setMenuOpen(false); }}>{t('mm.mob.fit')}</button>
              <button role="menuitem" onClick={() => { setSelection(new Set()); setMapSheet(true); setSheet('full'); setMenuOpen(false); }}>{t('mm.mob.pitch')}</button>
              <button role="menuitem" onClick={() => { setCoach(true); setMenuOpen(false); }}>{t('mm.mob.how')}</button>
            </div>
          </div>
        )}
        {hostPanel}
      </div>
    );
  }

  return (
    <div className="mm-work">
      <header className="mm-top">
        <button className="mm-brand" onClick={exit} title={t('mm.backToMaps')}>‹ {t('mm.brand')}</button>
        <span className="mm-top__div" />
        <label className="mm-top__name">
          <span>{t('mm.mapNameLabel')}</span>
          <input value={map.name} maxLength={40} aria-label={t('mm.mapName')}
            onChange={(e) => transient({ ...map, name: e.target.value })} onBlur={commitName} />
        </label>
        <div className="mm-row">
          <button className="mm-icon" aria-label={t('mm.undo')} title={t('mm.undoKey')} disabled={!hist.past.length} onClick={undo}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></svg>
          </button>
          <button className="mm-icon" aria-label={t('mm.redo')} title={t('mm.redoKey')} disabled={!hist.future.length} onClick={redo}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></svg>
          </button>
        </div>
        <span className="mm-top__fill" />
        <span className={`mm-savestate is-${saveState}`}>
          {t(saveState === 'saved' ? 'mm.save.allSaved' : saveState === 'saving' ? 'mm.save.saving' : saveState === 'error' ? 'mm.save.notSaved' : saveState === 'fresh' ? 'mm.save.notYet' : 'mm.save.soon')}
        </span>
        <button className={`mm-status${statusCls}`} onClick={() => setShowCheck(s => !s)}>{blockers || warnings ? t('mm.status.withList', { status }) : status}</button>
        <button className={`mm-btn${preview ? ' is-on' : ''}`} onClick={() => setPreview(p => !p)}>{preview ? t('mm.stage.stop') : t('mm.stage.preview')}</button>
        <button className="mm-btn is-teal" onClick={save} disabled={saveState === 'saving'}>{saveLabel}</button>
        <button className="mm-btn is-gold" onClick={() => setShowHost(true)}>{t('mm.top.share')}</button>
      </header>
      {saveError && <div className="mm-banner is-bad">{saveError}</div>}
      {noticeBanner}

      <div className="mm-work__body">
        <aside className="mm-rail">
          <div className="mm-rail__tools">{tools}</div>
          {treeView}
        </aside>
        {stage}
        <aside className="mm-side">{inspector}</aside>
      </div>
      {hostPanel}
    </div>
  );
}

const MapMaker: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const [open, setOpen] = useState<{ map: CustomMap; id: string | null; key: number; opts: OpenOpts } | null>(null);
  if (!open) {
    return <StartScreen onExit={onExit} onOpen={(map, id, opts) => setOpen({ map, id, key: Date.now(), opts: opts ?? {} })} />;
  }
  return <Workshop key={open.key} initial={open.map} initialId={open.id} opts={open.opts} onExit={() => setOpen(null)} />;
};

export default MapMaker;
