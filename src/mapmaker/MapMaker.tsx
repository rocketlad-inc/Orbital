// ============================================================
// THE MAP MAKER (Lorne, 2026-10-14): build a star system, then host a
// game on it. Anyone can build and save; hosting a game on your own map
// is the Commander's Commission; anyone can join one.
//
// Design: the "Orbital Map Maker" canvas (5 boards). Format and rules:
// src/game/customMap.js, shared with the server. Server:
// worker/customMaps.js + index.js handleHostMap. Staging only for now.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './mapmaker.css';
import { apiFetch, startCommissionCheckout } from '../multiplayer/api';
import { canBuyHere, openCommissionInBrowser, COMMISSION_NAME, COMMISSION_PRICE } from '../multiplayer/commission';
import {
  type CustomMap, type MapIssue, blankMap, normalizeMap, checkMap, generateMap, startWorlds,
  NAME_THEMES, TYPE_INFO, type MapBodyType,
} from '../game/customMap';
import { MapView, type PlaceTool } from './MapView';
import { BodyInspector, SunInspector, EmptyInspector, BulkBar } from './Inspector';
import { placeBody, deleteBodies, duplicateBodies } from './ops';
import type { Scale } from './geometry';

type Summary = {
  id: string; name: string; share_code: string; updated_ms: number; hosted_count: number;
  bodies: number; blockers: number; warnings: number; sun_color: string;
};
type Hist = { past: CustomMap[]; present: CustomMap; future: CustomMap[] };

const DRAFT_KEY = 'orbital.mapmaker.draft';
const PALETTE: Array<{ tool: PlaceTool; label: string }> = [
  { tool: 'terrestrial', label: 'Planet' }, { tool: 'gas-giant', label: 'Gas giant' },
  { tool: 'ice-giant', label: 'Ice giant' }, { tool: 'moon', label: 'Moon' },
  { tool: 'dwarf', label: 'Dwarf' }, { tool: 'belt', label: 'Asteroid belt' },
  { tool: 'asteroid', label: 'Asteroid' }, { tool: 'rock', label: 'Rock' },
];

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

function PaletteIcon({ tool }: { tool: PlaceTool }) {
  if (tool === 'belt') return <span className="mm-pal__belt" aria-hidden />;
  if (tool === 'rock') return <span className="mm-pal__rock" aria-hidden />;
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

/** The issue chip and its drawer. */
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

/** Share and host. */
function HostPanel({
  map, summary, canHost, onSaveFirst, onToggleSecrets, onClose,
}: {
  map: CustomMap; summary: Summary | null; canHost: boolean;
  onSaveFirst: () => Promise<Summary | null>; onToggleSecrets: (on: boolean) => void; onClose: () => void;
}) {
  const starts = startWorlds(map).worlds.length;
  const most = Math.max(2, Math.min(10, starts));
  const [seats, setSeats] = useState(most);
  const [name, setName] = useState(map.name);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const blockers = checkMap(map).filter(i => i.level === 'block');
  const sellable = canBuyHere();

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
  const buy = async () => {
    const url = await startCommissionCheckout('map-maker');
    if (url) window.location.href = url;
  };

  return (
    <div className="mm-modal" role="dialog" aria-label="Share and host">
      <div className="mm-modal__card">
        <div className="mm-modal__head"><b>Share &amp; host</b><button className="mm-icon" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="mm-modal__cols">
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
                    <input className="mm-input" type="number" min={2} max={most} value={seats} onChange={(e) => setSeats(Math.max(2, Math.min(most, Number(e.target.value))))} />
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

/** The first screen: templates, the generator, your maps, a share code. */
function StartScreen({ onOpen, onExit }: { onOpen: (map: CustomMap, id: string | null) => void; onExit: () => void }) {
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
        <span className="mm-top__fill" />
        <label className="mm-top__code">
          <span>Have a share code?</span>
          <input className="mm-input" placeholder="ORB-7KQ2-HELN" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') importCode(); }} />
        </label>
        <button className="mm-btn is-teal" onClick={importCode} disabled={!code.trim()}>Open</button>
      </header>
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
            {draft && draft.map.bodies.length > 0 && (
              <button className="mm-tpl" onClick={() => onOpen(draft.map, draft.id)}>
                <span className="mm-tpl__art is-draft" aria-hidden><span className="mm-tpl__sun" /></span>
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
                <span className={`mm-tag ${s.blockers ? 'is-bad' : 'is-ok'}`}>{s.blockers ? `${s.blockers} BLOCKER${s.blockers > 1 ? 'S' : ''}` : 'READY'}</span>
              </button>
              <button className="mm-icon" aria-label={`Delete ${s.name}`} onClick={() => remove(s)}>✕</button>
            </div>
          ))}
          <div className="mm-gold-note"><b>❖ {COMMISSION_NAME} holders</b> host games on their own maps. Anyone can build, save a map and join a game on one.</div>
        </aside>
      </div>
    </div>
  );
}

/** The workshop: the map, the tools, the inspector. */
function Workshop({ initial, initialId, onExit }: { initial: CustomMap; initialId: string | null; onExit: () => void }) {
  const [hist, setHist] = useState<Hist>({ past: [], present: initial, future: [] });
  const pending = useRef<CustomMap | null>(null);
  const map = hist.present;
  const [mapId, setMapId] = useState<string | null>(initialId);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [canHost, setCanHost] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<PlaceTool | null>(null);
  const [theme, setTheme] = useState('Mythic');
  const [scale, setScale] = useState<Scale>('compressed');
  const [preview, setPreview] = useState(false);
  const [fit, setFit] = useState(0);
  const [showCheck, setShowCheck] = useState(false);
  const [showHost, setShowHost] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving' | 'error'>(initialId ? 'saved' : 'unsaved');
  const [saveError, setSaveError] = useState<string | null>(null);

  const issues = useMemo(() => checkMap(map), [map]);
  const blockers = issues.filter(i => i.level === 'block').length;
  const warnings = issues.filter(i => i.level === 'warn').length;

  useEffect(() => {
    apiFetch<{ maps: Summary[]; can_host: boolean }>('/api/maps').then(res => {
      if (res.ok) {
        setCanHost(res.data.can_host);
        if (initialId) setSummary(res.data.maps.find(m => m.id === initialId) ?? null);
      }
    });
  }, [initialId]);
  useEffect(() => { saveDraft(map, mapId); }, [map, mapId]);

  /** A committed edit: the old map goes on the undo stack. */
  const commit = useCallback((next: CustomMap, select?: string[]) => {
    setHist(h => {
      const base = pending.current ?? h.present;
      pending.current = null;
      if (JSON.stringify(base) === JSON.stringify(next) && h.present === next) return h;
      return { past: [...h.past.slice(-99), base], present: next, future: [] };
    });
    if (select) setSelection(new Set(select));
    setSaveState('unsaved');
  }, []);
  /** A live edit mid-drag or mid-slide: shown, not yet an undo step. */
  const transient = useCallback((next: CustomMap) => {
    setHist(h => {
      if (!pending.current) pending.current = h.present;
      return { ...h, present: next };
    });
    setSaveState('unsaved');
  }, []);
  const undo = useCallback(() => setHist(h => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)), []);
  const redo = useCallback(() => setHist(h => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)), []);

  const save = useCallback(async (): Promise<Summary | null> => {
    setSaveState('saving'); setSaveError(null);
    const res = mapId
      ? await apiFetch<{ map: CustomMap; summary: Summary }>(`/api/maps/${mapId}`, { method: 'PUT', body: JSON.stringify({ map }) })
      : await apiFetch<{ map: CustomMap; summary: Summary }>('/api/maps', { method: 'POST', body: JSON.stringify({ map }) });
    if (!res.ok) { setSaveState('error'); setSaveError(res.error?.message ?? 'Could not save.'); return null; }
    setMapId(res.data.summary.id);
    setSummary(res.data.summary);
    setSaveState('saved');
    return res.data.summary;
  }, [map, mapId]);

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
        const ids = [...selection].filter(id => id !== 'sun');
        if (ids.length) commit(deleteBodies(map, ids), []);
      } else if (e.key === 'Escape') { setTool(null); setSelection(new Set()); setShowCheck(false); }
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
  };
  const onPlace = (t: PlaceTool, parent: string, orbit: number, angle: number) => {
    const r = placeBody(map, t, parent, orbit, angle, theme);
    commit(r.map, r.ids);
  };
  const onMove = (id: string, orbit: number, angle: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'end') { commit(map); return; }
    transient(normalizeMap({ ...map, bodies: map.bodies.map(b => (b.id === id ? { ...b, orbit, angle } : b)) }));
  };

  const selIds = [...selection].filter(id => id === 'sun' || map.bodies.some(b => b.id === id));
  const single = selIds.length === 1 ? selIds[0] : null;
  const singleBody = single && single !== 'sun' ? map.bodies.find(b => b.id === single) ?? null : null;
  const bulkIds = selIds.filter(id => id !== 'sun');

  // The tree: the sun's worlds in orbit order, each with its moons.
  const tree = useMemo(() => {
    const sunKids = map.bodies.filter(b => b.parent === 'sun').sort((a, b) => a.orbit - b.orbit);
    const rows: Array<{ id: string; name: string; color: string; depth: number; tag: string }> = [];
    for (const b of sunKids) {
      rows.push({ id: b.id, name: b.name, color: b.color, depth: 0, tag: b.start ? '✦' : b.secret ? '?' : b.type === 'asteroid' ? '·' : '' });
      for (const m of map.bodies.filter(x => x.parent === b.id).sort((a, c) => a.orbit - c.orbit)) {
        rows.push({ id: m.id, name: m.name, color: m.color, depth: 1, tag: m.start ? '✦' : m.secret ? '?' : '' });
      }
    }
    return rows;
  }, [map]);

  return (
    <div className="mm-work">
      <header className="mm-top">
        <button className="mm-brand" onClick={onExit} title="Back to your maps">‹ MAP MAKER</button>
        <span className="mm-top__div" />
        <label className="mm-top__name">
          <span>MAP NAME</span>
          <input value={map.name} maxLength={40} aria-label="Map name"
            onChange={(e) => transient({ ...map, name: e.target.value })} onBlur={() => commit(map)} />
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
        <button className={`mm-status${blockers ? ' is-bad' : warnings ? ' is-warn' : ' is-ok'}`} onClick={() => setShowCheck(s => !s)}>
          {blockers ? `✕ ${blockers} blocker${blockers > 1 ? 's' : ''}` : warnings ? `! Checklist · ${warnings} warning${warnings > 1 ? 's' : ''}` : '✓ Ready to play'}
        </button>
        <button className={`mm-btn${preview ? ' is-on' : ''}`} onClick={() => setPreview(p => !p)}>{preview ? 'Stop motion' : 'Preview in motion'}</button>
        <button className="mm-btn is-teal" onClick={save} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save'}
        </button>
        <button className="mm-btn is-gold" onClick={() => setShowHost(true)}>❖ Share &amp; host</button>
      </header>
      {saveError && <div className="mm-banner is-bad">{saveError}</div>}

      <div className="mm-work__body">
        <aside className="mm-rail">
          <div className="mm-sec">CLICK, THEN CLICK THE MAP</div>
          <div className="mm-pal">
            {PALETTE.map(p => (
              <button key={p.tool} className={`mm-pal__btn${tool === p.tool ? ' is-on' : ''}`} onClick={() => setTool(tool === p.tool ? null : p.tool)} aria-pressed={tool === p.tool}>
                <PaletteIcon tool={p.tool} />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
          <div className="mm-row mm-row--wrap">
            <span className="mm-field__l">NEW NAMES</span>
            <select className="mm-input is-small" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Name theme for new worlds">
              {NAME_THEMES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="mm-sec">YOUR SYSTEM · {map.bodies.length} BODIES</div>
          <div className="mm-tree">
            <button className={`mm-tree__row${selection.has('sun') ? ' is-sel' : ''}`} onClick={(e) => onSelect(['sun'], e.shiftKey ? 'toggle' : 'replace')}>
              <span className="mm-dot" style={{ background: map.sun.color }} />{map.sun.name}<span className="mm-tree__tag">SUN</span>
            </button>
            {tree.map(r => (
              <button key={r.id} className={`mm-tree__row${selection.has(r.id) ? ' is-sel' : ''}`} style={{ paddingLeft: 8 + r.depth * 16 }}
                onClick={(e) => onSelect([r.id], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')}>
                <span className="mm-dot" style={{ background: r.color }} />{r.name}<span className="mm-tree__tag">{r.tag}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="mm-stage">
          <MapView
            map={map} scale={scale} selection={selection} tool={tool} preview={preview} fitSignal={fit}
            onSelect={onSelect} onPlace={onPlace} onMove={onMove} onCancelTool={() => setTool(null)}
          />
          <div className="mm-stage__ctl">
            <button className={`mm-btn is-small${scale === 'compressed' ? ' is-on' : ''}`} onClick={() => setScale(scale === 'compressed' ? 'true' : 'compressed')}>
              {scale === 'compressed' ? 'Compressed distances' : 'True distances'}
            </button>
            <button className="mm-btn is-small" onClick={() => setFit(f => f + 1)}>Fit system</button>
          </div>
          <div className="mm-stage__hint mm-mono">Drag empty space to select a group · Shift-click adds · Right-drag pans · Wheel zooms</div>
          {showCheck && <Checklist issues={issues} onShow={(ids) => { setSelection(new Set(ids)); setShowCheck(false); }} onClose={() => setShowCheck(false)} />}
          {bulkIds.length > 1 && (
            <BulkBar map={map} ids={bulkIds} theme={theme} onChange={commit} onClear={() => setSelection(new Set())} />
          )}
        </main>

        <aside className="mm-side">
          {single === 'sun'
            ? <SunInspector map={map} onChange={commit} onTransient={transient} />
            : singleBody
              ? <BodyInspector key={singleBody.id} map={map} body={singleBody} theme={theme} onChange={commit} onTransient={transient} />
              : bulkIds.length > 1
                ? <div className="mm-insp"><div className="mm-insp__body"><div className="mm-sec">{bulkIds.length} SELECTED</div><p className="mm-note">Use the bar under the map to change them all at once. Shift-click a world to add or drop it.</p></div></div>
                : <EmptyInspector map={map} />}
        </aside>
      </div>

      {showHost && (
        <HostPanel
          map={map} summary={summary} canHost={canHost} onSaveFirst={save}
          onToggleSecrets={(on) => commit({ ...map, settings: { ...map.settings, shareHidesSecrets: on } })}
          onClose={() => setShowHost(false)}
        />
      )}
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
