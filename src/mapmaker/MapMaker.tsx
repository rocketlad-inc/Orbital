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
import { canBuyHere, openCommissionInBrowser, COMMISSION_NAME, COMMISSION_PRICE } from '../multiplayer/commission';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  type CustomMap, type MapIssue, type MapBodyType, type MapBackdrop, blankMap, normalizeMap, checkMap, generateMap, startWorlds, sectorOf,
  NAME_THEMES, TYPE_INFO,
} from '../game/customMap';
import { MapView, type Tool } from './MapView';
import { BodyInspector, SunInspector, MapInspector, SectorInspector, BulkBar, Stepper, BACKDROP_LABEL } from './Inspector';
import {
  placeBody, deleteBodies, duplicateBodies, placeSymmetric, ringOf, scatterAsteroids, matchBodies, type MatchAspect,
  addSector, updateSector, deleteSectors,
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
const PALETTE: Array<{ tool: Tool; label: string }> = [
  { tool: 'terrestrial', label: 'Planet' }, { tool: 'gas-giant', label: 'Gas giant' },
  { tool: 'ice-giant', label: 'Ice giant' }, { tool: 'moon', label: 'Moon' },
  { tool: 'dwarf', label: 'Dwarf' }, { tool: 'belt', label: 'Asteroid belt' },
  { tool: 'asteroid', label: 'Asteroid' }, { tool: 'rock', label: 'Rock' },
];
const RING_TYPES: MapBodyType[] = ['terrestrial', 'dwarf', 'gas-giant', 'ice-giant', 'asteroid'];
const SYMMETRY = [1, 2, 3, 4, 5, 6, 8];

function saveDraft(map: CustomMap, id: string | null) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ map, id, at: Date.now() })); } catch { /* private mode */ }
}
function loadDraft(): { map: CustomMap; id: string | null; at: number } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return { map: normalizeMap(d.map), id: typeof d.id === 'string' ? d.id : null, at: Number(d.at) || 0 };
  } catch { return null; }
}
function coached(): boolean { try { return localStorage.getItem(COACH_KEY) === '1'; } catch { return true; } }
function markCoached() { try { localStorage.setItem(COACH_KEY, '1'); } catch { /* private mode */ } }

function PaletteIcon({ tool }: { tool: Tool }) {
  if (tool === 'belt') return <span className="mm-pal__belt" aria-hidden />;
  if (tool === 'rock') return <span className="mm-pal__rock" aria-hidden />;
  if (tool === 'scatter') return <span className="mm-pal__spray" aria-hidden />;
  if (tool === 'ring') return <span className="mm-pal__ringtool" aria-hidden />;
  if (tool === 'sector') return <span className="mm-pal__sector" aria-hidden />;
  const t = tool as MapBodyType;
  const d = { terrestrial: 22, 'gas-giant': 30, 'ice-giant': 26, moon: 14, dwarf: 16, asteroid: 10, rock: 8 }[t] ?? 16;
  const c = TYPE_INFO[t].color;
  const gas = t === 'gas-giant';
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
  return (
    <div className="mm-drawer" role="dialog" aria-label="Is it ready to play?">
      <div className="mm-drawer__head">
        <b>Is it ready to play?</b>
        <span className="mm-mono">checked as you edit</span>
        <button className="mm-icon" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      {[...issues].sort((a, b) => ({ block: 0, warn: 1, ok: 2 }[a.level] - { block: 0, warn: 1, ok: 2 }[b.level])).map(i => (
        <div key={i.code} className={`mm-issue is-${i.level}`}>
          <span className="mm-issue__mark" aria-hidden>{i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'}</span>
          <div className="mm-issue__t">
            <b>{i.title}</b>
            <span>{i.detail}</span>
          </div>
          {i.level !== 'ok' && i.bodyIds.length > 0 && <button className="mm-btn is-small" onClick={() => onShow(i.bodyIds)}>Show me</button>}
        </div>
      ))}
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

  const host = async () => {
    setBusy(true); setError(null);
    // The lobby copies the saved map, so save what's on screen first.
    const s = await onSaveFirst();
    if (!s) { setBusy(false); setError('The map did not save, so no lobby was opened.'); return; }
    const res = await apiFetch<{ room: { id: string } }>(`/api/maps/${s.id}/host`, {
      method: 'POST', body: JSON.stringify({ name, max_players: seats, password: password || undefined }),
    });
    setBusy(false);
    if (!res.ok) { setError(res.error?.message ?? 'Could not open the lobby.'); return; }
    try { sessionStorage.setItem('orbital.tab_room', res.data.room.id); } catch { /* private mode */ }
    window.location.href = '/';
  };
  const publish = async (on: boolean) => {
    setPubBusy(true); setPubError(null);
    const s = await onSaveFirst();
    if (!s) { setPubBusy(false); setPubError('Save the map first.'); return; }
    const res = await apiFetch<{ summary: Summary }>(`/api/maps/${s.id}/publish`, { method: 'POST', body: JSON.stringify({ on }) });
    setPubBusy(false);
    if (!res.ok) { setPubError(res.error?.message ?? 'Could not change that.'); return; }
    onPublished(res.data.summary);
  };
  const buy = async () => {
    const url = await startCommissionCheckout('map-maker');
    if (url) window.location.href = url;
  };

  return (
    <div className="mm-modal" role="dialog" aria-label="Share and host">
      <div className="mm-modal__card">
        <div className="mm-modal__head"><b>Share &amp; host</b><button className="mm-icon" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="mm-modal__cols">
          <div className="mm-modal__stack">
            <section className="mm-panel">
              <h3>Share this map</h3>
              {summary ? (
                <>
                  <div className="mm-row">
                    <input className="mm-input is-code" readOnly value={summary.share_code} aria-label="Share code" />
                    <button className="mm-btn" onClick={() => { navigator.clipboard?.writeText(summary.share_code); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <p className="mm-note">Anyone with the code can open a copy in their own Map Maker. Your original stays yours.</p>
                </>
              ) : <p className="mm-note">Save the map to get its share code.</p>}
              <label className="mm-check">
                <input type="checkbox" checked={map.settings.shareHidesSecrets} onChange={(e) => onToggleSecrets(e.target.checked)} />
                <span>Keep hidden discoveries secret in shared copies</span>
              </label>
            </section>
            <section className="mm-panel">
              <h3>Publish to the gallery</h3>
              <div className="mm-pub">
                <MiniSystem thumb={thumbOf(map)} size={86} />
                <div className="mm-pub__t">
                  <b>{map.name}</b>
                  {map.blurb ? <span className="mm-note">{map.blurb}</span> : <span className="mm-note is-dim">No pitch yet. <button className="mm-link" onClick={onEditPitch}>Write one</button>: it is what makes people open a map.</span>}
                </div>
              </div>
              {blockers.length > 0 && !published ? (
                <p className="mm-note is-bad">Fix the blockers first: {blockers.map(b => b.title).join('; ')}.</p>
              ) : (
                <button className={`mm-btn is-wide${published ? '' : ' is-teal'}`} disabled={pubBusy} onClick={() => publish(!published)}>
                  {pubBusy ? '…' : published ? 'Unpublish' : 'Publish for everyone to play and remix'}
                </button>
              )}
              {published && <p className="mm-note">Live in the gallery. Remixed ×{summary?.remix_count ?? 0}, hosted ×{summary?.hosted_count ?? 0}.</p>}
              {pubError && <p className="mm-note is-bad">{pubError}</p>}
            </section>
          </div>
          <section className="mm-panel is-gold">
            <h3>❖ Host a game on {map.name}</h3>
            {blockers.length > 0 ? (
              <p className="mm-note is-bad">Not yet: {blockers.map(b => b.title).join('; ')}. See the checklist.</p>
            ) : canHost ? (
              <>
                <div className="mm-grid2">
                  <label className="mm-field"><span className="mm-field__l">LOBBY NAME</span>
                    <input className="mm-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="mm-field"><span className="mm-field__l">SEATS · up to {most}</span>
                    <Stepper label="Seats" value={seats} min={2} max={most} onChange={setSeats} />
                  </label>
                  <label className="mm-field"><span className="mm-field__l">PASSWORD (optional)</span>
                    <input className="mm-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </div>
                <button className="mm-btn is-gold is-wide" disabled={busy} onClick={host}>{busy ? 'Opening…' : 'Open the lobby'}</button>
                {error && <p className="mm-note is-bad">{error}</p>}
                <p className="mm-note">The lobby keeps a copy of the map as it is now: later edits never change a game already set up. It seats one player per start world.</p>
              </>
            ) : (
              <>
                <p className="mm-note">Hosting a game on your own map is part of the {COMMISSION_NAME} ({COMMISSION_PRICE}, once). Players who join don't need it.</p>
                {sellable ? (
                  <button className="mm-btn is-gold is-wide" onClick={buy}>Get the Commission</button>
                ) : (
                  <button className="mm-btn is-gold is-wide" onClick={() => openCommissionInBrowser('map-maker')}>Get the Commission in your browser</button>
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
function Gallery({ onOpen }: { onOpen: (map: CustomMap, id: string | null) => void }) {
  const [sort, setSort] = useState<'popular' | 'new'>('popular');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ item: GalleryItem; map: CustomMap } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      const res = await apiFetch<{ items: GalleryItem[]; next: string | null }>(`/api/maps/gallery?sort=${sort}&q=${encodeURIComponent(q.trim())}&limit=30`);
      if (!live) return;
      if (res.ok) { setItems(res.data.items); setError(null); } else setError(res.error?.message ?? 'The gallery did not load.');
    }, q ? 250 : 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [sort, q]);

  const look = async (item: GalleryItem) => {
    const res = await apiFetch<{ map: CustomMap; item: GalleryItem }>(`/api/maps/gallery/${item.id}`);
    if (res.ok) setPeek({ item: res.data.item ?? item, map: normalizeMap(res.data.map) });
    else setError(res.error?.message ?? 'That map did not open.');
  };
  const remix = async (item: GalleryItem) => {
    setBusy(true);
    const res = await apiFetch<{ map: CustomMap; summary: Summary }>(`/api/maps/${item.id}/remix`, { method: 'POST' });
    setBusy(false);
    if (res.ok) onOpen(normalizeMap(res.data.map), res.data.summary.id);
    else setError(res.error?.message ?? 'Could not remix that map.');
  };

  return (
    <div className="mm-gallery">
      <div className="mm-row mm-row--wrap">
        <div className="mm-seg">
          <button className={`mm-chip${sort === 'popular' ? ' is-on' : ''}`} onClick={() => setSort('popular')}>Most played</button>
          <button className={`mm-chip${sort === 'new' ? ' is-on' : ''}`} onClick={() => setSort('new')}>Newest</button>
        </div>
        <span className="mm-top__fill" />
        <input className="mm-input mm-gallery__q" placeholder="Search maps" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search maps" />
      </div>
      {error && <p className="mm-note is-bad">{error}</p>}
      {items === null && !error && <p className="mm-note">Loading the gallery…</p>}
      {items?.length === 0 && <p className="mm-note">{q ? 'No published map has that name.' : 'Nobody has published a map yet. Yours could be the first.'}</p>}
      <div className="mm-gallery__grid">
        {items?.map(it => (
          <button key={it.id} className="mm-gcard" onClick={() => look(it)}>
            <MiniSystem thumb={it.thumb} size={140} />
            <span className="mm-gcard__t">
              <b>{it.name}</b>
              <span className="mm-mono">by {it.author}{it.mine ? ' (you)' : ''}</span>
              {it.blurb && <span className="mm-gcard__blurb">{it.blurb}</span>}
              <span className="mm-mono">{it.starts} seats · {it.bodies} bodies · played ×{it.hosted_count} · remixed ×{it.remix_count}</span>
            </span>
          </button>
        ))}
      </div>
      {peek && (
        <div className="mm-modal" role="dialog" aria-label={peek.item.name}>
          <div className="mm-modal__card is-narrow">
            <div className="mm-modal__head"><b>{peek.item.name}</b><button className="mm-icon" aria-label="Close" onClick={() => setPeek(null)}>✕</button></div>
            <div className="mm-peek">
              <MiniSystem thumb={thumbOf(peek.map)} size={260} />
              <div className="mm-peek__t">
                <span className="mm-mono">by {peek.item.author}</span>
                {peek.map.blurb && <p className="mm-peek__blurb">{peek.map.blurb}</p>}
                <span className="mm-mono">{startWorlds(peek.map).worlds.length} start worlds · {peek.map.bodies.length} bodies · {BACKDROP_LABEL[peek.map.settings.backdrop]}</span>
                <span className="mm-mono">played ×{peek.item.hosted_count} · remixed ×{peek.item.remix_count}</span>
                <button className="mm-btn is-primary is-wide" disabled={busy} onClick={() => remix(peek.item)}>
                  {busy ? 'Copying…' : peek.item.mine ? 'Open a copy' : 'Remix it: a copy of your own'}
                </button>
                <p className="mm-note">Your copy is yours to change, rename and host. Hidden discoveries may arrive as surprises.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The first screen: templates, the generator, your maps, the gallery. */
function StartScreen({ onOpen, onExit }: { onOpen: (map: CustomMap, id: string | null) => void; onExit: () => void }) {
  const [tab, setTab] = useState<'build' | 'gallery'>('build');
  const [maps, setMaps] = useState<Summary[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState({ planets: 7, moonsMin: 0, moonsMax: 3, belts: 1, richness: 1, starts: 8, spread: 1, theme: 'Mythic', seed: Math.floor(Math.random() * 99999) });
  const draft = useMemo(loadDraft, []);

  const refresh = useCallback(async () => {
    const res = await apiFetch<{ maps: Summary[] }>('/api/maps');
    if (res.ok) setMaps(res.data.maps);
    else setError(res.status === 404 ? 'The Map Maker is not open on this server yet.' : res.error?.message ?? 'Could not load your maps.');
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const open = async (id: string) => {
    const res = await apiFetch<{ map: CustomMap }>(`/api/maps/${id}`);
    if (res.ok) onOpen(normalizeMap(res.data.map), id);
    else setError(res.error?.message ?? 'Could not open that map.');
  };
  const remove = async (s: Summary) => {
    if (!window.confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    await apiFetch(`/api/maps/${s.id}`, { method: 'DELETE' });
    refresh();
  };
  const importCode = async () => {
    setError(null);
    const res = await apiFetch<{ map: CustomMap; summary: Summary }>('/api/maps/import', { method: 'POST', body: JSON.stringify({ code }) });
    if (res.ok) onOpen(normalizeMap(res.data.map), res.data.summary.id);
    else setError(res.error?.message ?? 'That code did not open a map.');
  };
  const sol = async () => {
    const res = await apiFetch<{ map: CustomMap }>('/api/maps/template/sol');
    if (res.ok) onOpen(normalizeMap(res.data.map), null);
    else setError(res.error?.message ?? 'Could not load the Solar System.');
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
        <button className="mm-brand" onClick={onExit} title="Back to the lobby">‹ MAP MAKER</button>
        <div className="mm-seg mm-top__tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'build'} className={`mm-chip${tab === 'build' ? ' is-on' : ''}`} onClick={() => setTab('build')}>Build</button>
          <button role="tab" aria-selected={tab === 'gallery'} className={`mm-chip${tab === 'gallery' ? ' is-on' : ''}`} onClick={() => setTab('gallery')}>Gallery</button>
        </div>
        <span className="mm-top__fill" />
        <label className="mm-top__code">
          <span>Have a share code?</span>
          <input className="mm-input" placeholder="ORB-7KQ2-HELN" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') importCode(); }} />
        </label>
        <button className="mm-btn is-teal" onClick={importCode} disabled={!code.trim()}>Open</button>
      </header>
      {tab === 'gallery' ? (
        <div className="mm-start__body is-single">
          <div className="mm-start__main">
            <h1 className="mm-h1">The gallery</h1>
            <p className="mm-note">Systems other players built and published. Open one, remix it, make it yours.</p>
            <Gallery onOpen={onOpen} />
          </div>
        </div>
      ) : (
        <div className="mm-start__body">
          <div className="mm-start__main">
            <h1 className="mm-h1">Start a new map</h1>
            <p className="mm-note">Pick a starting point. Everything on it can be changed.</p>
            {error && <p className="mm-note is-bad">{error}</p>}
            <div className="mm-templates">
              <button className="mm-tpl" onClick={() => onOpen(blankMap('My system'), null)}>
                <span className="mm-tpl__art is-blank" aria-hidden><span className="mm-tpl__sun" /></span>
                <b>Just a sun</b><span>An empty star. Build every world yourself.</span>
              </button>
              <button className="mm-tpl" onClick={sol}>
                <span className="mm-tpl__art is-sol" aria-hidden><span className="mm-tpl__sun" /></span>
                <b>Our Solar System</b><span>The planets, their moons, the belt and the Kuiper worlds, ready to rename and reshape.</span>
              </button>
              <button className="mm-tpl" onClick={() => setTab('gallery')}>
                <span className="mm-tpl__art is-gallery" aria-hidden><span className="mm-tpl__sun" /></span>
                <b>Remix someone's</b><span>Browse the gallery of published systems and start from one.</span>
              </button>
              {draft && draft.map.bodies.length > 0 && (
                <button className="mm-tpl" onClick={() => onOpen(draft.map, draft.id)}>
                  <span className="mm-tpl__art is-draft" aria-hidden><MiniSystem thumb={thumbOf(draft.map)} size={104} /></span>
                  <b>Carry on: {draft.map.name}</b><span>Where you left off, {draft.map.bodies.length} bodies.</span>
                </button>
              )}
            </div>

            <section className="mm-gen">
              <div className="mm-gen__head"><b>Generate one for me</b><span className="mm-note">Set the shape, roll, then edit anything you don't like.</span></div>
              <div className="mm-gen__grid">
                {slider('planets', 'PLANETS', 2, 14, 1, v => String(v))}
                {slider('moonsMax', 'MOONS PER PLANET (MOST)', 0, 6, 1, v => `0–${v}`)}
                {slider('belts', 'ASTEROID BELTS', 0, 3, 1, v => String(v))}
                {slider('richness', 'RICHNESS', 0.4, 2.5, 0.1, v => (v < 0.8 ? 'Lean' : v < 1.3 ? 'Fair' : v < 1.9 ? 'Generous' : 'Lavish'))}
                {slider('starts', 'START WORLDS', 2, 10, 1, v => String(v))}
                {slider('spread', 'SPREAD', 0.6, 1.6, 0.05, v => (v < 0.85 ? 'Tight' : v < 1.2 ? 'Even' : 'Wide'))}
              </div>
              <div className="mm-row mm-row--wrap">
                <span className="mm-field__l">NAME THEME</span>
                {NAME_THEMES.map(t => <button key={t} className={`mm-chip${gen.theme === t ? ' is-on' : ''}`} onClick={() => setGen({ ...gen, theme: t })}>{t}</button>)}
                <span className="mm-top__fill" />
                <span className="mm-mono">seed {gen.seed}</span>
                <button className="mm-btn is-primary" onClick={() => onOpen(generateMap({ ...gen }), null)}>Roll a system</button>
              </div>
            </section>
          </div>

          <aside className="mm-start__side">
            <div className="mm-sec">YOUR MAPS</div>
            {maps === null && !error && <p className="mm-note">Loading…</p>}
            {maps?.length === 0 && <p className="mm-note">No saved maps yet.</p>}
            {maps?.map(s => (
              <div key={s.id} className="mm-mapcard">
                <button className="mm-mapcard__open" onClick={() => open(s.id)}>
                  <span className="mm-mapcard__art" style={{ background: `radial-gradient(circle, ${s.sun_color} 0 6px, #101a26 7px)` }} aria-hidden />
                  <span className="mm-mapcard__t">
                    <b>{s.name}</b>
                    <span className="mm-mono">{s.bodies} bodies · {new Date(s.updated_ms).toLocaleDateString()}{s.hosted_count ? ` · hosted ×${s.hosted_count}` : ''}</span>
                  </span>
                  {s.published && <span className="mm-tag is-pub">PUBLISHED</span>}
                  <span className={`mm-tag ${s.blockers ? 'is-bad' : 'is-ok'}`}>{s.blockers ? `${s.blockers} BLOCKER${s.blockers > 1 ? 'S' : ''}` : 'READY'}</span>
                </button>
                <button className="mm-icon" aria-label={`Delete ${s.name}`} onClick={() => remove(s)}>✕</button>
              </div>
            ))}
            <div className="mm-gold-note"><b>❖ {COMMISSION_NAME} holders</b> host games on their own maps. Anyone can build, save, publish a map and join a game on one.</div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** First visit only: three short tips over the map. */
function Coach({ touch, onDone }: { touch: boolean; onDone: () => void }) {
  const steps = touch
    ? [
      ['Tap + to add worlds', 'Pick a planet, a moon, a belt or a paint tool, then tap the map. It keeps placing until you tap Done.'],
      ['Tap a world to shape it', 'Its sheet slides up: name, resources, look, lore and secrets. Drag a selected world to move it.'],
      ['Long-press to gather', 'Long-press worlds (or empty space, then drag) to select a group and change them all at once.'],
    ]
    : [
      ['Pick, then click', 'Choose a world on the left, then click the map. Symmetry places it several ways round the sun at once.'],
      ['Click a world to shape it', 'Name it, set what it yields, paint its surface, write its lore, hide a discovery.'],
      ['Drag to gather', 'Drag across empty space to select a group, then change them all from the bar under the map.'],
    ];
  const [i, setI] = useState(0);
  return (
    <div className="mm-coach" role="dialog" aria-label="How the Map Maker works">
      <span className="mm-mono">{i + 1} of {steps.length}</span>
      <b>{steps[i][0]}</b>
      <p>{steps[i][1]}</p>
      <div className="mm-row mm-row--end">
        <button className="mm-btn is-small" onClick={onDone}>Skip</button>
        {i < steps.length - 1
          ? <button className="mm-btn is-small is-primary" onClick={() => setI(i + 1)}>Next</button>
          : <button className="mm-btn is-small is-primary" onClick={onDone}>Start building</button>}
      </div>
    </div>
  );
}

/** The workshop: the map, the tools, the inspector. */
function Workshop({ initial, initialId, onExit }: { initial: CustomMap; initialId: string | null; onExit: () => void }) {
  const mobile = useIsMobile();
  const [hist, setHist] = useState<Hist>({ past: [], present: initial, future: [] });
  const pending = useRef<CustomMap | null>(null);
  const version = useRef(0);
  const saving = useRef(false);
  const map = hist.present;
  const [mapId, setMapId] = useState<string | null>(initialId);
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
  const [saveState, setSaveState] = useState<'fresh' | 'saved' | 'unsaved' | 'saving' | 'error'>(initialId ? 'saved' : 'fresh');
  const [saveError, setSaveError] = useState<string | null>(null);
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
        if (initialId) setSummary(res.data.maps.find(m => m.id === initialId) ?? null);
      }
    });
  }, [initialId]);
  useEffect(() => { saveDraft(map, mapId); }, [map, mapId]);

  const touched = () => { version.current++; setSaveState('unsaved'); };
  /** A committed edit: the old map goes on the undo stack. */
  const commit = useCallback((next: CustomMap, select?: string[]) => {
    setHist(h => {
      const base = pending.current ?? h.present;
      pending.current = null;
      if (JSON.stringify(base) === JSON.stringify(next) && h.present === next) return h;
      return { past: [...h.past.slice(-99), base], present: next, future: [] };
    });
    if (select) setSelection(new Set(select));
    touched();
  }, []);
  /** A live edit mid-drag or mid-slide: shown, not yet an undo step. */
  const transient = useCallback((next: CustomMap) => {
    setHist(h => {
      if (!pending.current) pending.current = h.present;
      return { ...h, present: next };
    });
    touched();
  }, []);
  const undo = useCallback(() => { setHist(h => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)); touched(); }, []);
  const redo = useCallback(() => { setHist(h => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)); touched(); }, []);

  const mapRef = useRef(map);
  mapRef.current = map;
  const idRef = useRef(mapId);
  idRef.current = mapId;
  /** Save to the server. Edits made while a save is in flight keep the
   *  map "unsaved" so the autosave goes round again. */
  const save = useCallback(async (): Promise<Summary | null> => {
    if (saving.current) return null;
    saving.current = true;
    const v = version.current;
    const id = idRef.current;
    setSaveState('saving'); setSaveError(null);
    const body = JSON.stringify({ map: normalizeMap(mapRef.current) });
    const res = id
      ? await apiFetch<{ map: CustomMap; summary: Summary }>(`/api/maps/${id}`, { method: 'PUT', body })
      : await apiFetch<{ map: CustomMap; summary: Summary }>('/api/maps', { method: 'POST', body });
    saving.current = false;
    if (!res.ok) { setSaveState('error'); setSaveError(res.error?.message ?? 'Could not save.'); return null; }
    setMapId(res.data.summary.id);
    idRef.current = res.data.summary.id;
    setSummary(s => ({ ...(s ?? {}), ...res.data.summary }));
    setSaveState(version.current === v ? 'saved' : 'unsaved');
    return res.data.summary;
  }, []);

  // Autosave: a few seconds after the last edit, never mid-drag.
  useEffect(() => {
    if (saveState !== 'unsaved' || map.bodies.length === 0) return;
    const t = window.setTimeout(() => { if (!pending.current) save(); }, 3000);
    return () => window.clearTimeout(t);
  }, [map, saveState, save]);

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
  const onPlace = (t: Tool, parent: string, orbit: number, angle: number) => {
    if (t === 'sector') return;
    const r = t === 'ring' ? ringOf(map, ringType, ringCount, orbit, angle, theme)
      : parent !== 'sun' || t === 'belt' || t === 'moon' || t === 'scatter' ? placeBody(map, t as Exclude<Tool, 'scatter' | 'ring' | 'sector'>, parent, orbit, angle, theme)
        : placeSymmetric(map, t as Exclude<Tool, 'scatter' | 'ring' | 'sector'>, orbit, angle, theme, symmetry);
    commit(r.map, r.ids);
  };
  const onScatter = (pts: Array<{ orbit: number; angle: number }>) => {
    const r = scatterAsteroids(map, pts, theme);
    commit(r.map, r.ids);
  };
  const onMove = (id: string, orbit: number, angle: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'end') { commit(map); return; }
    transient(normalizeMap({ ...map, bodies: map.bodies.map(b => (b.id === id ? { ...b, orbit, angle } : b)) }));
  };
  const onPick = (srcId: string) => {
    if (!picking) return;
    commit(matchBodies(map, srcId, picking.ids, picking.aspects), picking.ids);
    setPicking(null);
  };
  const pickTool = (t: Tool) => { setTool(tool === t ? null : t); setPalOpen(false); setPicking(null); };

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
    if (phase === 'end') { commit(normalizeMap(map), [`sector:${id}`]); return; }
    const i = map.sectors.findIndex(x => x.id === id);
    const sct = map.sectors[i];
    if (!sct) return;
    // An edge stops at its neighbour and never crosses its own other edge.
    const lo = which === 'inner' ? (map.sectors[i - 1]?.outer ?? 0) : sct.inner + 10;
    const hi = which === 'inner' ? sct.outer - 10 : (map.sectors[i + 1]?.inner ?? 15400);
    transient(updateSector(map, id, { [which]: Math.max(lo, Math.min(hi, orbit)) }, false));
  };

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
          rows.push({ id: sct ? `sector:${sct.id}` : `loose:${b.id}`, name: sct ? sct.name : 'Outside every sector', color: sct?.color ?? '#8fa6ba', depth: 0, tag: '', moons: 0, head: true });
        }
      }
      rows.push({ id: b.id, name: b.name, color: b.color, depth: 0, tag: b.start ? '✦' : b.secret ? '?' : b.type === 'asteroid' ? '·' : '', moons: moons.length });
      if (folded.has(b.id) && !q) continue;
      for (const m of hitMoons) rows.push({ id: m.id, name: m.name, color: m.color, depth: 1, tag: m.start ? '✦' : m.secret ? '?' : '', moons: 0 });
    }
    return rows;
  }, [map, treeQ, folded]);
  const fold = (id: string) => setFolded(f => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const status = blockers ? `✕ ${blockers} blocker${blockers > 1 ? 's' : ''}` : warnings ? `! ${warnings} warning${warnings > 1 ? 's' : ''}` : '✓ Ready to play';
  const statusCls = blockers ? ' is-bad' : warnings ? ' is-warn' : ' is-ok';
  const saveLabel = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Retry save' : 'Save';
  const toolHint = picking
    ? `${mobile ? 'Tap' : 'Click'} the world to copy from`
    : tool === 'scatter' ? `Drag across the map to spray asteroids`
      : tool === 'ring' ? (mobile ? 'Tap an orbit' : 'Click where the ring should circle')
      : tool === 'sector' ? (mobile ? 'Drag from one orbit to another' : 'Drag from one orbit out to another to draw a sector')
        : tool === 'moon' ? `${mobile ? 'Tap' : 'Click'} beside a planet to give it a moon`
          : tool === 'belt' ? `${mobile ? 'Tap' : 'Click'} where the belt should circle`
            : tool ? `${mobile ? 'Tap' : 'Click'} to place${symmetry > 1 ? ` · ${symmetry} ways round the sun` : ''}` : null;

  const tools = (
    <>
      <div className="mm-sec">{mobile ? 'WORLDS' : 'CLICK, THEN CLICK THE MAP'}</div>
      <div className="mm-pal">
        {PALETTE.map(p => (
          <button key={p.tool} className={`mm-pal__btn${tool === p.tool ? ' is-on' : ''}`} onClick={() => pickTool(p.tool)} aria-pressed={tool === p.tool}>
            <PaletteIcon tool={p.tool} />
            <span>{p.label}</span>
          </button>
        ))}
      </div>
      <div className="mm-sec">PAINT</div>
      <div className="mm-pal is-paint">
        <button className={`mm-pal__btn${tool === 'scatter' ? ' is-on' : ''}`} onClick={() => pickTool('scatter')} aria-pressed={tool === 'scatter'}>
          <PaletteIcon tool="scatter" /><span>Spray asteroids</span>
        </button>
        <button className={`mm-pal__btn${tool === 'ring' ? ' is-on' : ''}`} onClick={() => pickTool('ring')} aria-pressed={tool === 'ring'}>
          <PaletteIcon tool="ring" /><span>Ring of worlds</span>
        </button>
        <button className={`mm-pal__btn is-wide${tool === 'sector' ? ' is-on' : ''}`} onClick={() => pickTool('sector')} aria-pressed={tool === 'sector'}>
          <PaletteIcon tool="sector" /><span>Draw a sector</span>
        </button>
      </div>
      {tool === 'ring' && (
        <div className="mm-box is-tight">
          <div className="mm-row mm-row--wrap">
            <span className="mm-field__l">HOW MANY</span>
            <Stepper label="Worlds in the ring" value={ringCount} min={2} max={12} onChange={setRingCount} />
          </div>
          <div className="mm-row mm-row--wrap">
            {RING_TYPES.map(t => <button key={t} className={`mm-chip is-small${ringType === t ? ' is-on' : ''}`} onClick={() => setRingType(t)}>{TYPE_INFO[t].label}</button>)}
          </div>
        </div>
      )}
      <div className="mm-sec mm-sec--row"><span>SYMMETRY</span><span className="mm-mono">{symmetry > 1 ? `${symmetry} ways` : 'off'}</span></div>
      <div className="mm-sym" role="radiogroup" aria-label="Symmetry">
        {SYMMETRY.map(n => (
          <button key={n} role="radio" aria-checked={symmetry === n} className={`mm-chip is-small${symmetry === n ? ' is-on' : ''}`} onClick={() => setSymmetry(n)}>
            {n === 1 ? 'Off' : `×${n}`}
          </button>
        ))}
      </div>
      <div className="mm-row mm-row--wrap">
        <span className="mm-field__l">NEW NAMES</span>
        <select className="mm-input is-small" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Name theme for new worlds">
          {NAME_THEMES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    </>
  );

  const treeView = (
    <>
      <div className="mm-sec">YOUR SYSTEM · {map.bodies.length} BODIES</div>
      <input className="mm-input is-small mm-tree__q" placeholder="Find a world" value={treeQ} onChange={(e) => setTreeQ(e.target.value)} aria-label="Find a world" />
      <div className="mm-tree">
        <button className={`mm-tree__row${selection.has('sun') ? ' is-sel' : ''}`} onClick={(e) => { onSelect(['sun'], e.shiftKey ? 'toggle' : 'replace'); setListOpen(false); }}>
          <span className="mm-dot" style={{ background: map.sun.color }} />{map.sun.name}<span className="mm-tree__tag">SUN</span>
        </button>
        {tree.map(r => (r.head ? (
          r.id.startsWith('sector:')
            ? (
              <button key={r.id} className={`mm-tree__head${selection.has(r.id) ? ' is-sel' : ''}`} style={{ color: r.color }} onClick={() => { onSelect([r.id], 'replace'); setListOpen(false); }}>
                {r.name.toUpperCase()}
              </button>
            )
            : <div key={r.id} className="mm-tree__head is-loose">{r.name.toUpperCase()}</div>
        ) : (
          <div key={r.id} className="mm-tree__line" style={{ paddingLeft: r.depth * 16 }}>
            {r.depth === 0 && r.moons > 0
              ? <button className="mm-tree__fold" aria-label={folded.has(r.id) ? 'Show moons' : 'Hide moons'} onClick={() => fold(r.id)}>{folded.has(r.id) ? '▸' : '▾'}</button>
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
          ? <div className="mm-insp"><div className="mm-insp__body"><div className="mm-sec">{bulkIds.length} SELECTED</div><p className="mm-note">Use the bar under the map to change them all at once. Shift-click a world to add or drop it.</p></div></div>
          : <MapInspector map={map} theme={theme} touch={mobile} onChange={commit} onTransient={transient}
            onDrawSector={() => { setTool('sector'); setMapSheet(false); setPicking(null); }}
            onPickSector={(id) => { setSelection(new Set([`sector:${id}`])); setMapSheet(false); setSheet('peek'); }} />;

  const lensPanel = lens && (
    <div className={`mm-lenspanel${lensOpen ? '' : ' is-folded'}`}>
      <button className="mm-lenspanel__head" onClick={() => setLensOpen(o => !o)} aria-expanded={lensOpen}>
        <b>Fairness</b>
        <span className={`mm-tag ${lens.score >= 80 ? 'is-ok' : lens.score >= 55 ? 'is-warn' : 'is-bad'}`}>{lens.score}%</span>
        <span className="mm-mono">{lensOpen ? '▾' : '▸'} {lens.starts.length} starts</span>
      </button>
      {lensOpen && <p className="mm-note">What lies nearest each start world at the opening. 100% means every player's neighbourhood is worth the same.</p>}
      {lensOpen && [...lens.starts].sort((a, b) => b.total - a.total).map(s => (
        <button key={s.id} className="mm-lensrow" onClick={() => onSelect([s.id], 'replace')}>
          <span className="mm-dot" style={{ background: s.color }} />
          <span className="mm-lensrow__n">{s.name}</span>
          <span className="mm-mono">{s.metal}·{s.credits}·{s.science}</span>
          <span className="mm-lensrow__bar"><span style={{ width: `${(s.total / Math.max(1, ...lens.starts.map(x => x.total))) * 100}%`, background: s.color }} /></span>
        </button>
      ))}
      {lensOpen && <span className="mm-mono">metal · credits · science per tick</span>}
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
            {scale === 'compressed' ? 'Compressed distances' : 'True distances'}
          </button>
          <button className="mm-btn is-small" onClick={() => setFit(f => f + 1)}>Fit system</button>
          <button className={`mm-btn is-small${lensOn ? ' is-on' : ''}`} onClick={() => setLensOn(l => !l)}>Fairness lens</button>
        </div>
      )}
      {toolHint && (
        <div className="mm-toolhint">
          <span>{toolHint}</span>
          {tool === 'ring' && <Stepper label="Worlds in the ring" value={ringCount} min={2} max={12} onChange={setRingCount} />}
          <button className="mm-btn is-small is-primary" onClick={() => { setTool(null); setPicking(null); }}>{picking ? 'Cancel' : 'Done'}</button>
        </div>
      )}
      {lensPanel}
      {noLens && <div className="mm-lenspanel"><p className="mm-note">The lens needs at least two start worlds.</p></div>}
      {!mobile && <div className="mm-stage__hint mm-mono">Drag empty space to select a group · Shift-click adds · Right-drag pans · Wheel zooms</div>}
      {showCheck && <Checklist issues={issues} onShow={(ids) => { setSelection(new Set(ids)); setShowCheck(false); setSheet('peek'); }} onClose={() => setShowCheck(false)} />}
      {!mobile && bulkIds.length > 1 && !picking && (
        <BulkBar map={map} ids={bulkIds} theme={theme} onChange={commit} onClear={() => setSelection(new Set())} onMatch={(a) => { setPicking({ aspects: a, ids: bulkIds }); setTool(null); }} />
      )}
      {coach && <Coach touch={mobile} onDone={() => { setCoach(false); markCoached(); }} />}
    </main>
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
    const showSheet = selIds.length > 0 || mapSheet;
    return (
      <div className="mm-work is-mobile">
        <header className="mm-top">
          <button className="mm-icon" aria-label="Back to your maps" onClick={onExit}>‹</button>
          <input className="mm-top__mname" value={map.name} maxLength={40} aria-label="Map name"
            onChange={(e) => transient({ ...map, name: e.target.value })} onBlur={() => commit(normalizeMap(map))} />
          <button className="mm-icon" aria-label="Undo" disabled={!hist.past.length} onClick={undo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></svg>
          </button>
          <button className="mm-icon" aria-label="Redo" disabled={!hist.future.length} onClick={redo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></svg>
          </button>
          <button className={`mm-status is-dot${statusCls}`} aria-label={status} onClick={() => setShowCheck(s => !s)}>{blockers ? '✕' : warnings ? '!' : '✓'}</button>
          <button className="mm-icon" aria-label="More" onClick={() => setMenuOpen(true)}>⋯</button>
        </header>
        {saveError && <div className="mm-banner is-bad">{saveError}</div>}
        <div className="mm-work__body">{stage}</div>

        {!tool && !picking && (
          <>
            <button className="mm-fab" aria-label="Add to the map" onClick={() => setPalOpen(true)}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            {!showSheet && <button className="mm-fab is-left" aria-label="The whole map: pitch, mood, sky" onClick={() => { setMapSheet(true); setSheet('full'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M14 6l4 4" /></svg>
            </button>}
          </>
        )}

        {showSheet && !tool && !picking && (
          <div className={`mm-sheet is-${sheet}`}>
            <div className="mm-sheet__bar">
              <button className="mm-sheet__grip" aria-label={sheet === 'peek' ? 'Expand' : 'Shrink'} onClick={() => setSheet(sheet === 'peek' ? 'full' : 'peek')} />
              <button className="mm-icon" aria-label="Close" onClick={() => { setSelection(new Set()); setMapSheet(false); }}>✕</button>
            </div>
            <div className="mm-sheet__body" onFocus={() => setSheet('full')}>{inspector}</div>
          </div>
        )}

        {palOpen && (
          <div className="mm-scrim" onClick={() => setPalOpen(false)}>
            <div className="mm-sheet is-full is-pal" onClick={(e) => e.stopPropagation()}>
              <div className="mm-sheet__bar"><b>Add to the map</b><button className="mm-icon" aria-label="Close" onClick={() => setPalOpen(false)}>✕</button></div>
              <div className="mm-sheet__body mm-rail is-sheet">{tools}</div>
            </div>
          </div>
        )}
        {listOpen && (
          <div className="mm-scrim" onClick={() => setListOpen(false)}>
            <div className="mm-sheet is-full" onClick={(e) => e.stopPropagation()}>
              <div className="mm-sheet__bar"><b>Every world</b><button className="mm-icon" aria-label="Close" onClick={() => setListOpen(false)}>✕</button></div>
              <div className="mm-sheet__body mm-rail is-sheet">{treeView}</div>
            </div>
          </div>
        )}
        {menuOpen && (
          <div className="mm-scrim" onClick={() => setMenuOpen(false)}>
            <div className="mm-menu" onClick={(e) => e.stopPropagation()} role="menu">
              <button role="menuitem" onClick={() => { save(); setMenuOpen(false); }}>{saveLabel}{saveState === 'saved' ? ' ✓' : ''}</button>
              <button role="menuitem" className="is-gold" onClick={() => { setShowHost(true); setMenuOpen(false); }}>❖ Share, publish &amp; host</button>
              <button role="menuitem" onClick={() => { setListOpen(true); setMenuOpen(false); }}>Every world ({map.bodies.length})</button>
              <button role="menuitem" onClick={() => { setLensOn(l => !l); setMenuOpen(false); }}>{lensOn ? 'Hide' : 'Show'} the fairness lens</button>
              <button role="menuitem" onClick={() => { setPreview(p => !p); setMenuOpen(false); }}>{preview ? 'Stop motion' : 'Preview in motion'}</button>
              <button role="menuitem" onClick={() => { setScale(scale === 'compressed' ? 'true' : 'compressed'); setMenuOpen(false); }}>{scale === 'compressed' ? 'True distances' : 'Compressed distances'}</button>
              <button role="menuitem" onClick={() => { setFit(f => f + 1); setMenuOpen(false); }}>Fit the system</button>
              <button role="menuitem" onClick={() => { setSelection(new Set()); setMapSheet(true); setSheet('full'); setMenuOpen(false); }}>Pitch, mood &amp; sky</button>
              <button role="menuitem" onClick={() => { setCoach(true); setMenuOpen(false); }}>How it works</button>
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
        <button className="mm-brand" onClick={onExit} title="Back to your maps">‹ MAP MAKER</button>
        <span className="mm-top__div" />
        <label className="mm-top__name">
          <span>MAP NAME</span>
          <input value={map.name} maxLength={40} aria-label="Map name"
            onChange={(e) => transient({ ...map, name: e.target.value })} onBlur={() => commit(normalizeMap(map))} />
        </label>
        <div className="mm-row">
          <button className="mm-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!hist.past.length} onClick={undo}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></svg>
          </button>
          <button className="mm-icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!hist.future.length} onClick={redo}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></svg>
          </button>
        </div>
        <span className="mm-top__fill" />
        <span className={`mm-savestate is-${saveState}`}>{saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : saveState === 'fresh' ? 'Not saved yet' : 'Autosaves in a moment'}</span>
        <button className={`mm-status${statusCls}`} onClick={() => setShowCheck(s => !s)}>{blockers || warnings ? `${status} · checklist` : status}</button>
        <button className={`mm-btn${preview ? ' is-on' : ''}`} onClick={() => setPreview(p => !p)}>{preview ? 'Stop motion' : 'Preview in motion'}</button>
        <button className="mm-btn is-teal" onClick={save} disabled={saveState === 'saving'}>{saveLabel}</button>
        <button className="mm-btn is-gold" onClick={() => setShowHost(true)}>❖ Share &amp; host</button>
      </header>
      {saveError && <div className="mm-banner is-bad">{saveError}</div>}

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
  const [open, setOpen] = useState<{ map: CustomMap; id: string | null; key: number } | null>(null);
  if (!open) {
    return <StartScreen onExit={onExit} onOpen={(map, id) => setOpen({ map, id, key: Date.now() })} />;
  }
  return <Workshop key={open.key} initial={open.map} initialId={open.id} onExit={() => setOpen(null)} />;
};

export default MapMaker;
