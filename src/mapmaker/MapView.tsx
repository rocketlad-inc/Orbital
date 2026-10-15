// The Map Maker's map: the system top-down, sun at the centre.
//
// Mouse: click a tool then the map to place; drag a world to move it
// along or between orbits (it snaps to other worlds' orbits; hold Alt to
// stop it); drag empty space to lasso a group; right-drag or space-drag
// to pan; the wheel zooms about the cursor.
//
// Touch (the game's own rules): drag pans, pinch zooms, tap selects,
// long-press adds to the selection (or, on empty space, starts a lasso);
// a world already selected drags to move.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomMap, MapBody, MapBodyType } from '../game/customMap';
import { bodyYear } from '../game/customMap';
import {
  discR, sunR, displayPos, displayToOrbit, orbitToDisplay, systemExtent, type Scale,
} from './geometry';
import { worldArt } from './planetArt';
import type { Fairness } from './fairness';

export type PlaceTool = MapBodyType | 'belt';
export type Tool = PlaceTool | 'scatter' | 'ring';

export interface MapViewProps {
  map: CustomMap;
  scale: Scale;
  selection: Set<string>;
  tool: Tool | null;
  preview: boolean;
  /** Bumped to re-fit the whole system in view. */
  fitSignal: number;
  /** Touch rules (drag pans) instead of mouse rules (drag lassos). */
  touch: boolean;
  /** New sun-orbiting worlds are placed this many ways round the sun. */
  symmetry: number;
  /** How many worlds the ring tool lays down. */
  ringCount: number;
  /** The fairness lens, when on. */
  lens: Fairness | null;
  /** Eyedropper: the next world tapped is reported to onPick. */
  picking: boolean;
  onSelect: (ids: string[], mode: 'replace' | 'toggle' | 'add') => void;
  onPlace: (tool: Tool, parent: string, orbit: number, angle: number) => void;
  onScatter: (points: Array<{ orbit: number; angle: number }>) => void;
  onMove: (id: string, orbit: number, angle: number, phase: 'start' | 'move' | 'end') => void;
  onPick: (id: string) => void;
  onCancelTool: () => void;
}

type View = { x: number; y: number; z: number };
type Drag =
  | { kind: 'body'; id: string; moved: boolean; sx: number; sy: number }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'lasso'; sx: number; sy: number; ex: number; ey: number; additive: boolean }
  | { kind: 'scatter'; pts: Array<{ x: number; y: number }>; lx: number; ly: number }
  | { kind: 'tap'; sx: number; sy: number; wx: number; wy: number };

type Readout = { x: number; y: number; lines: string[]; snapId: string | null };

/** Lighter/darker of a hex colour, for the shading gradients. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

const MOON_HOSTS = new Set<MapBodyType>(['terrestrial', 'gas-giant', 'ice-giant', 'dwarf']);
const LONG_PRESS_MS = 450;
const SNAP_PX = 9;

export const MapView: React.FC<MapViewProps> = ({
  map, scale, selection, tool, preview, fitSignal, touch, symmetry, ringCount, lens, picking,
  onSelect, onPlace, onScatter, onMove, onPick, onCancelTool,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 0.2 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [time, setTime] = useState(0);
  const [readout, setReadout] = useState<Readout | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; z0: number; wx: number; wy: number } | null>(null);
  const press = useRef<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit the system whenever asked (a new map, "Fit system", a scale switch).
  useEffect(() => {
    const ext = systemExtent(map, scale);
    setView({ x: 0, y: 0, z: Math.max(0.02, Math.min(3, Math.min(size.w, size.h) / (2 * ext * 1.05))) });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refit on demand, not on every edit
  }, [fitSignal, scale, size.w > 0 && size.h > 0]);

  // Motion preview: every world runs along its orbit, a year in a few seconds.
  useEffect(() => {
    if (!preview) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      setTime(t => t + (now - last) * 0.02);
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [preview]);
  const spin = useCallback((b: MapBody) => (preview ? (2 * Math.PI * time) / Math.max(4, bodyYear(map, b)) : 0),
    [preview, time, map]);

  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e.target)) setSpaceDown(true); };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // The page's own scroll and zoom must not steal the wheel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  useEffect(() => () => { if (press.current) window.clearTimeout(press.current); }, []);

  const pos = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    for (const b of map.bodies) out.set(b.id, displayPos(map, b, scale, spin));
    return out;
  }, [map, scale, spin]);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    const sx = clientX - (r?.left ?? 0), sy = clientY - (r?.top ?? 0);
    return { x: view.x + (sx - size.w / 2) / view.z, y: view.y + (sy - size.h / 2) / view.z, sx, sy };
  }, [view, size]);

  /** The world a moon dropped here would orbit: the nearest planet whose
   *  disc it lands near. */
  const moonHostAt = useCallback((wx: number, wy: number): MapBody | null => {
    let best: MapBody | null = null, bestD = Infinity;
    for (const b of map.bodies) {
      if (b.parent !== 'sun' || !MOON_HOSTS.has(b.type)) continue;
      const p = pos.get(b.id)!;
      const d = Math.hypot(p.x - wx, p.y - wy);
      const reach = discR(b) + 70 / Math.max(view.z, 0.2) * 0.4 + 60;
      if (d < reach && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }, [map, pos, view.z]);

  const place = (wx: number, wy: number) => {
    if (!tool || tool === 'scatter') return;
    if (tool === 'moon') {
      const host = moonHostAt(wx, wy);
      if (!host) return;
      const hp = pos.get(host.id)!;
      const d = Math.max(discR(host) + 8, Math.hypot(wx - hp.x, wy - hp.y));
      onPlace('moon', host.id, displayToOrbit(map, host.id, d, scale), Math.atan2(wy - hp.y, wx - hp.x));
      return;
    }
    const d = Math.max(sunR(map) + 30, Math.hypot(wx, wy));
    onPlace(tool, 'sun', displayToOrbit(map, 'sun', d, scale), Math.atan2(wy, wx));
  };

  /** A moon too close to its planet to see at this zoom. */
  const moonHidden = (b: MapBody) => {
    if (b.parent === 'sun' || selection.has(b.id)) return false;
    const host = map.bodies.find(x => x.id === b.parent);
    return !!host && (orbitToDisplay(map, b, scale) - discR(host)) * view.z < 5;
  };
  /** The world nearest the pointer, within reach of a finger (or a
   *  mouse): the nearest centre wins, so a moon beside its planet never
   *  steals a tap meant for the planet. */
  const hitAt = (sx: number, sy: number): string | null => {
    let best: string | null = null, bd = Infinity;
    const consider = (id: string, wx: number, wy: number, r: number) => {
      const d = Math.hypot(size.w / 2 + (wx - view.x) * view.z - sx, size.h / 2 + (wy - view.y) * view.z - sy);
      if (d <= Math.max(r * view.z, touch ? 20 : 9) && d < bd) { bd = d; best = id; }
    };
    consider('sun', 0, 0, sunR(map));
    for (const b of map.bodies) {
      if (moonHidden(b)) continue;
      const p = pos.get(b.id)!;
      consider(b.id, p.x, p.y, discR(b));
    }
    return best;
  };

  const cancelPress = () => { if (press.current) { window.clearTimeout(press.current); press.current = null; } };

  /** A world being dragged: where it would land, snapped to a nearby
   *  orbit unless Alt is held, and the readout beside the pointer. */
  const dragTo = (b: MapBody, wx: number, wy: number, sx: number, sy: number, noSnap: boolean) => {
    let cx = 0, cy = 0;
    if (b.parent !== 'sun') {
      const pp = pos.get(b.parent) ?? { x: 0, y: 0 };
      cx = pp.x; cy = pp.y;
    }
    let d = Math.hypot(wx - cx, wy - cy);
    const angle = Math.atan2(wy - cy, wx - cx);
    const peers = map.bodies.filter(x => x.id !== b.id && x.parent === b.parent && x.type !== 'asteroid' && x.type !== 'rock');
    let snap: MapBody | null = null;
    if (!noSnap) {
      let best = SNAP_PX / view.z;
      for (const p of peers) {
        const pd = orbitToDisplay(map, p, scale);
        if (Math.abs(pd - d) < best) { best = Math.abs(pd - d); snap = p; }
      }
      if (snap) d = orbitToDisplay(map, snap, scale);
    }
    const orbit = snap ? snap.orbit : displayToOrbit(map, b.parent, d, scale);
    const year = Math.round(bodyYear(map, { ...b, orbit }));
    const ring = peers.map(x => x.orbit).filter(o => o !== orbit).sort((p, q) => p - q);
    const inner = ring.filter(o => o < orbit).pop();
    const outer = ring.find(o => o > orbit);
    const gaps = [
      inner != null ? `${Math.round(orbit - inner)} out from the next world in` : null,
      outer != null ? `${Math.round(outer - orbit)} in from the next world out` : null,
    ].filter(Boolean).join(' · ');
    setReadout({
      x: sx, y: sy, snapId: snap?.id ?? null,
      lines: [`Orbit ${Math.round(orbit)} · year ${year} ticks`, snap ? `On ${snap.name}’s orbit` : (gaps || 'Nothing else round here')],
    });
    return { orbit, angle };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    // A second finger: pinch. Whatever the first finger was doing stops.
    if (pointers.current.size === 2) {
      cancelPress();
      if (drag?.kind === 'body' && drag.moved) {
        const b = map.bodies.find(x => x.id === drag.id);
        if (b) onMove(b.id, b.orbit, b.angle, 'end');
      }
      const [a, c] = [...pointers.current.values()];
      const mid = toWorld((a.x + c.x) / 2, (a.y + c.y) / 2);
      pinch.current = { d0: Math.max(10, Math.hypot(a.x - c.x, a.y - c.y)), z0: view.z, wx: mid.x, wy: mid.y };
      setDrag(null);
      setGhost(null);
      setReadout(null);
      return;
    }
    if (pointers.current.size > 2) return;

    const id = hitAt(w.sx, w.sy);

    if (e.button === 1 || e.button === 2 || spaceDown) {
      setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: true });
      return;
    }
    if (picking) { if (id && id !== 'sun') onPick(id); return; }
    if (tool === 'scatter') {
      setDrag({ kind: 'scatter', pts: [{ x: w.x, y: w.y }], lx: w.sx, ly: w.sy });
      return;
    }
    if (tool) {
      // A touch places on lift, so a pan or pinch that starts on the map
      // never drops a world by accident. A mouse places at once.
      if (touch) { setGhost({ x: w.x, y: w.y }); setDrag({ kind: 'tap', sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y }); }
      else place(w.x, w.y);
      return;
    }
    if (touch) {
      if (id && id !== 'sun' && selection.has(id)) {
        setDrag({ kind: 'body', id, moved: false, sx: e.clientX, sy: e.clientY });
      } else {
        // Drag pans; a lift without moving is a tap; holding still adds
        // the world to the selection, or starts a lasso on empty space.
        setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false });
      }
      cancelPress();
      press.current = window.setTimeout(() => {
        press.current = null;
        try { navigator.vibrate?.(12); } catch { /* not everywhere */ }
        if (id) { onSelect([id], 'toggle'); setDrag(null); }
        else setDrag({ kind: 'lasso', sx: w.sx, sy: w.sy, ex: w.sx, ey: w.sy, additive: true });
      }, LONG_PRESS_MS);
      return;
    }
    if (id) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { onSelect([id], 'toggle'); return; }
      if (!selection.has(id)) onSelect([id], 'replace');
      if (id !== 'sun') setDrag({ kind: 'body', id, moved: false, sx: e.clientX, sy: e.clientY });
      return;
    }
    setDrag({ kind: 'lasso', sx: w.sx, sy: w.sy, ex: w.sx, ey: w.sy, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, c] = [...pointers.current.values()];
      const d = Math.max(10, Math.hypot(a.x - c.x, a.y - c.y));
      const z = Math.max(0.01, Math.min(8, pinch.current.z0 * (d / pinch.current.d0)));
      const r = wrapRef.current?.getBoundingClientRect();
      const mx = (a.x + c.x) / 2 - (r?.left ?? 0), my = (a.y + c.y) / 2 - (r?.top ?? 0);
      const p = pinch.current;
      setView({ z, x: p.wx - (mx - size.w / 2) / z, y: p.wy - (my - size.h / 2) / z });
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    if (tool && e.pointerType !== 'touch') setGhost({ x: w.x, y: w.y });
    if (!drag) return;
    const far = 'sx' in drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6;
    if (far) cancelPress();
    if (drag.kind === 'pan') {
      if (!far && !drag.moved) return;
      setView(v => ({ ...v, x: drag.vx - (e.clientX - drag.sx) / v.z, y: drag.vy - (e.clientY - drag.sy) / v.z }));
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else if (drag.kind === 'tap') {
      // A finger that moves while placing is panning instead.
      if (far) { setGhost(null); setDrag({ kind: 'pan', sx: drag.sx, sy: drag.sy, vx: view.x, vy: view.y, moved: true }); }
    } else if (drag.kind === 'lasso') {
      setDrag({ ...drag, ex: w.sx, ey: w.sy });
    } else if (drag.kind === 'scatter') {
      if (Math.hypot(w.sx - drag.lx, w.sy - drag.ly) < 16) return;
      const jitter = () => ((Math.random() - 0.5) * 10) / view.z;
      setDrag({ ...drag, pts: [...drag.pts, { x: w.x + jitter(), y: w.y + jitter() }], lx: w.sx, ly: w.sy });
    } else if (drag.kind === 'body') {
      if (!drag.moved && !far) return;
      const b = map.bodies.find(x => x.id === drag.id);
      if (!b) return;
      const at = dragTo(b, w.x, w.y, w.sx, w.sy, e.altKey);
      onMove(b.id, at.orbit, at.angle, drag.moved ? 'move' : 'start');
      if (!drag.moved) setDrag({ ...drag, moved: true });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    cancelPress();
    if (pinch.current) {
      if (pointers.current.size < 2) { pinch.current = null; setDrag(null); }
      return;
    }
    if (drag?.kind === 'body') {
      if (drag.moved) {
        const b = map.bodies.find(x => x.id === drag.id);
        if (b) onMove(b.id, b.orbit, b.angle, 'end');
      } else if (touch) {
        onSelect([drag.id], 'replace');
      }
    } else if (drag?.kind === 'pan' && touch && !drag.moved) {
      // A tap: select what was under the finger, or clear.
      const at = toWorld(e.clientX, e.clientY);
      const id = hitAt(at.sx, at.sy);
      onSelect(id ? [id] : [], 'replace');
    } else if (drag?.kind === 'tap') {
      place(drag.wx, drag.wy);
      setGhost(null);
    } else if (drag?.kind === 'scatter') {
      onScatter(drag.pts.map(p => ({
        orbit: displayToOrbit(map, 'sun', Math.max(sunR(map) + 30, Math.hypot(p.x, p.y)), scale),
        angle: Math.atan2(p.y, p.x),
      })));
    } else if (drag?.kind === 'lasso') {
      const x0 = Math.min(drag.sx, drag.ex), x1 = Math.max(drag.sx, drag.ex);
      const y0 = Math.min(drag.sy, drag.ey), y1 = Math.max(drag.sy, drag.ey);
      if (x1 - x0 < 4 && y1 - y0 < 4) {
        if (!drag.additive) onSelect([], 'replace');
      } else {
        const ids: string[] = [];
        for (const b of map.bodies) {
          const p = pos.get(b.id)!;
          const sx = size.w / 2 + (p.x - view.x) * view.z, sy = size.h / 2 + (p.y - view.y) * view.z;
          if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(b.id);
        }
        onSelect(ids, drag.additive ? 'add' : 'replace');
      }
    }
    setDrag(null);
    setReadout(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * 0.0015);
    setView(v => {
      const z = Math.max(0.01, Math.min(8, v.z * f));
      // Keep the point under the cursor where it is.
      return { z, x: w.x - (w.sx - size.w / 2) / z, y: w.y - (w.sy - size.h / 2) / z };
    });
  };

  const colors = useMemo(() => [...new Set([map.sun.color, ...map.bodies.map(b => b.color)])], [map]);
  const gid = (c: string) => `mmg_${c.replace('#', '')}`;
  const z = view.z;
  const px = (n: number) => n / z;   // n screen pixels, in display units
  const fs = touch ? 1.2 : 1;

  const ghostHost = tool === 'moon' && ghost ? moonHostAt(ghost.x, ghost.y) : null;
  const sunOrbits = map.bodies.filter(b => b.parent === 'sun' && b.type !== 'asteroid' && b.type !== 'rock');
  const around = (gx: number, gy: number, n: number) => {
    const a0 = Math.atan2(gy, gx), r = Math.hypot(gx, gy);
    return Array.from({ length: Math.max(1, n) }, (_, k) => {
      const a = a0 + (k * Math.PI * 2) / Math.max(1, n);
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
  };
  const ghostR = (t: MapBodyType) => discR({ type: t, radius: t === 'gas-giant' ? 8 : t === 'ice-giant' ? 5 : t === 'terrestrial' ? 3 : 1.2 });
  const snapped = readout?.snapId ?? null;
  const dragging = drag?.kind === 'body' && drag.moved ? map.bodies.find(b => b.id === drag.id) ?? null : null;
  const placingSym = !!tool && tool !== 'moon' && tool !== 'scatter' && tool !== 'ring' && tool !== 'belt' && symmetry > 1;

  return (
    <div
      ref={wrapRef}
      className={`mm-map${tool ? ' is-placing' : ''}${picking ? ' is-picking' : ''}${(drag?.kind === 'pan' && drag.moved) || spaceDown ? ' is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={(e) => { if (e.pointerType !== 'touch') setGhost(null); }}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancelTool(); }}
      role="application"
      aria-label="Star system map"
    >
      <svg width={size.w} height={size.h} className="mm-map__svg">
        <defs>
          {colors.map(c => (
            <radialGradient key={c} id={gid(c)} cx="38%" cy="34%" r="70%">
              <stop offset="0%" stopColor={shade(c, 0.45)} />
              <stop offset="55%" stopColor={c} />
              <stop offset="100%" stopColor={shade(c, -0.6)} />
            </radialGradient>
          ))}
          <radialGradient id="mm_sunglow">
            <stop offset="0%" stopColor={map.sun.color} stopOpacity="0.55" />
            <stop offset="100%" stopColor={map.sun.color} stopOpacity="0" />
          </radialGradient>
          {/* A world's art, lit on one side and in night on the other. */}
          <radialGradient id="mm_shade" cx="36%" cy="32%" r="78%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.18" />
            <stop offset="45%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.72" />
          </radialGradient>
          <clipPath id="mm_disc" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5" /></clipPath>
        </defs>
        <g transform={`translate(${size.w / 2 - view.x * z} ${size.h / 2 - view.y * z}) scale(${z})`}>
          {sunOrbits.map(b => (
            <circle key={`o_${b.id}`} r={orbitToDisplay(map, b, scale)}
              className={`mm-orbit${selection.has(b.id) ? ' is-sel' : ''}${snapped === b.id ? ' is-snap' : ''}`} />
          ))}
          {map.bodies.filter(b => b.parent !== 'sun').map(b => {
            const p = pos.get(b.parent);
            return p ? <circle key={`mo_${b.id}`} cx={p.x} cy={p.y} r={orbitToDisplay(map, b, scale)} className="mm-orbit is-moon" /> : null;
          })}
          {dragging && dragging.parent === 'sun' && !snapped && (
            <circle r={orbitToDisplay(map, dragging, scale)} className="mm-orbit is-drag" />
          )}

          {placingSym && ghost && around(ghost.x, ghost.y, symmetry).map((g, k) => (
            <line key={`sp_${k}`} x1={0} y1={0} x2={g.x * 1.06} y2={g.y * 1.06} className="mm-spoke" />
          ))}

          {/* the sun */}
          <circle r={sunR(map) * 2.4} fill="url(#mm_sunglow)" pointerEvents="none" />
          <g data-body="sun" className="mm-body">
            <circle r={sunR(map)} fill={`url(#${gid(map.sun.color)})`} />
            {selection.has('sun') && <circle r={sunR(map) + px(6)} className="mm-sel" />}
          </g>
          <text y={sunR(map) + px(16)} className="mm-label is-sun" fontSize={px(11 * fs)}>{map.sun.name.toUpperCase()}</text>

          {map.bodies.map(b => {
            const p = pos.get(b.id)!;
            const sel = selection.has(b.id);
            // Never smaller than a few screen pixels, or the whole-system
            // view is specks. A moon waits until it clears its planet.
            if (moonHidden(b)) return null;
            const r = Math.max(discR(b), px(b.type === 'asteroid' || b.type === 'rock' ? 1.6 : b.parent === 'sun' ? 4.5 : 2.5));
            // The game's own art once a disc is big enough to show it.
            const art = b.type !== 'rock' && z * r >= 7 ? worldArt(b) : null;
            const gas = !art && (b.surface === 'gas' || b.surface === 'storm');
            const owner = lens?.owner.get(b.id);
            const lensColor = owner ? lens!.colorOf.get(owner) : null;
            const isStart = !!lens && lens.colorOf.has(b.id);
            return (
              <g key={b.id} data-body={b.id} className="mm-body" transform={`translate(${p.x} ${p.y})`}>
                <circle r={Math.max(r, px(touch ? 16 : 9))} fill="transparent" />
                {lensColor && (
                  <circle r={r + px(isStart ? 9 : 4)} fill={isStart ? 'none' : lensColor} fillOpacity={0.28}
                    stroke={lensColor} strokeWidth={px(isStart ? 2.5 : 1)} pointerEvents="none" />
                )}
                {b.rings && <ellipse rx={r * 1.95} ry={r * 0.55} className="mm-ring" transform="rotate(-18)" />}
                {b.type === 'rock'
                  ? <path d={`M${-r} ${r * 0.2} L${-r * 0.3} ${-r * 0.8} L${r * 0.8} ${-r * 0.4} L${r} ${r * 0.5} L${r * 0.1} ${r * 0.9} Z`} fill={b.color} />
                  : art
                    ? (
                      <>
                        <image href={art} x={-r} y={-r} width={r * 2} height={r * 2} clipPath="url(#mm_disc)" preserveAspectRatio="xMidYMid slice" />
                        <circle r={r} fill="url(#mm_shade)" />
                      </>
                    )
                    : <circle r={r} fill={`url(#${gid(b.color)})`} />}
                {/* the near half of the rings crosses in front of the world */}
                {b.rings && <path d={`M${-r * 1.95} 0 A ${r * 1.95} ${r * 0.55} 0 0 0 ${r * 1.95} 0`} className="mm-ring" transform="rotate(-18)" />}
                {gas && (
                  <g opacity="0.35">
                    <ellipse rx={r * 0.92} ry={r * 0.12} cy={-r * 0.35} fill={shade(b.color, -0.4)} />
                    <ellipse rx={r * 0.98} ry={r * 0.1} cy={r * 0.15} fill={shade(b.color, 0.35)} />
                    <ellipse rx={r * 0.8} ry={r * 0.09} cy={r * 0.55} fill={shade(b.color, -0.3)} />
                  </g>
                )}
                {sel && <circle r={r + px(6)} className="mm-sel" />}
                {b.secret && (
                  <g transform={`translate(${r * 0.8 + px(3)} ${-r * 0.8 - px(3)})`}>
                    <circle r={px(6 * fs)} className="mm-badge is-secret" />
                    <text className="mm-badge__t" fontSize={px(8 * fs)} dy={px(3 * fs)}>?</text>
                  </g>
                )}
                {b.type !== 'asteroid' && b.type !== 'rock' && (b.parent === 'sun' || z * r > 4 || sel) && (
                  <text y={r + px(13 * fs)} className={`mm-label${b.start ? ' is-start' : ''}${sel ? ' is-sel' : ''}`} fontSize={px((b.parent === 'sun' ? 10.5 : 9) * fs)}>
                    {b.name.toUpperCase()}{b.start ? ' ✦' : ''}
                  </text>
                )}
              </g>
            );
          })}

          {drag?.kind === 'scatter' && drag.pts.map((p, i) => (
            <circle key={`sc_${i}`} cx={p.x} cy={p.y} r={px(3)} className="mm-ghost" />
          ))}
          {tool && ghost && tool !== 'scatter' && (
            tool === 'moon'
              ? (ghostHost
                ? <circle cx={ghost.x} cy={ghost.y} r={Math.max(px(4), discR({ type: 'moon', radius: 1.5 }))} className="mm-ghost" />
                : <circle cx={ghost.x} cy={ghost.y} r={px(10)} className="mm-ghost is-bad" />)
              : tool === 'belt'
                ? <circle r={Math.hypot(ghost.x, ghost.y)} className="mm-ghost is-belt" />
                : tool === 'ring'
                  ? (
                    <>
                      <circle r={Math.hypot(ghost.x, ghost.y)} className="mm-ghost is-belt" />
                      {around(ghost.x, ghost.y, ringCount).map((g, k) => <circle key={k} cx={g.x} cy={g.y} r={Math.max(px(5), ghostR('dwarf'))} className="mm-ghost" />)}
                    </>
                  )
                  : around(ghost.x, ghost.y, placingSym ? symmetry : 1).map((g, k) => (
                    <circle key={k} cx={g.x} cy={g.y} r={Math.max(px(5), ghostR(tool))} className={`mm-ghost${k ? ' is-twin' : ''}`} />
                  ))
          )}
          {ghostHost && <circle cx={pos.get(ghostHost.id)!.x} cy={pos.get(ghostHost.id)!.y} r={discR(ghostHost) + px(8)} className="mm-sel" />}
        </g>
        {drag?.kind === 'lasso' && (
          <rect
            x={Math.min(drag.sx, drag.ex)} y={Math.min(drag.sy, drag.ey)}
            width={Math.abs(drag.ex - drag.sx)} height={Math.abs(drag.ey - drag.sy)}
            className="mm-lasso"
          />
        )}
      </svg>
      {readout && (
        <div className="mm-readout" style={{ left: Math.min(readout.x + 18, size.w - 240), top: Math.max(4, readout.y - (touch ? 84 : 12)) }}>
          {readout.lines.map((l, i) => <div key={i} className={i === 1 && readout.snapId ? 'is-snap' : undefined}>{l}</div>)}
          {!touch && !readout.snapId && <div className="mm-readout__hint">Hold Alt to place freely</div>}
        </div>
      )}
    </div>
  );
};
