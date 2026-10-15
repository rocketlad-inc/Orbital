// The Map Maker's map: the system top-down, sun at the centre. Click a
// tool then the map to place; drag a world to move it along or between
// orbits; drag empty space to lasso a group; right-drag or space-drag to
// pan; the wheel zooms about the cursor.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomMap, MapBody, MapBodyType } from '../game/customMap';
import { bodyYear } from '../game/customMap';
import {
  discR, sunR, displayPos, displayToOrbit, orbitToDisplay, systemExtent, type Scale,
} from './geometry';

export type PlaceTool = MapBodyType | 'belt';

export interface MapViewProps {
  map: CustomMap;
  scale: Scale;
  selection: Set<string>;
  tool: PlaceTool | null;
  preview: boolean;
  /** Bumped to re-fit the whole system in view. */
  fitSignal: number;
  onSelect: (ids: string[], mode: 'replace' | 'toggle' | 'add') => void;
  onPlace: (tool: PlaceTool, parent: string, orbit: number, angle: number) => void;
  onMove: (id: string, orbit: number, angle: number, phase: 'start' | 'move' | 'end') => void;
  onCancelTool: () => void;
}

type View = { x: number; y: number; z: number };
type Drag =
  | { kind: 'body'; id: string; moved: boolean; sx: number; sy: number }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'lasso'; sx: number; sy: number; ex: number; ey: number; additive: boolean };

/** Lighter/darker of a hex colour, for the shading gradients. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

const MOON_HOSTS = new Set<MapBodyType>(['terrestrial', 'gas-giant', 'ice-giant', 'dwarf']);

export const MapView: React.FC<MapViewProps> = ({
  map, scale, selection, tool, preview, fitSignal, onSelect, onPlace, onMove, onCancelTool,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 0.2 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [time, setTime] = useState(0);

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
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) setSpaceDown(true); };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

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
    if (!tool) return;
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

  const onPointerDown = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    const target = (e.target as Element).closest('[data-body]') as HTMLElement | null;
    const id = target?.getAttribute('data-body') ?? null;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || spaceDown) {
      setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
      return;
    }
    if (tool) { place(w.x, w.y); return; }
    if (id) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { onSelect([id], 'toggle'); return; }
      if (!selection.has(id)) onSelect([id], 'replace');
      if (id !== 'sun') {
        setDrag({ kind: 'body', id, moved: false, sx: e.clientX, sy: e.clientY });
      }
      return;
    }
    setDrag({ kind: 'lasso', sx: w.sx, sy: w.sy, ex: w.sx, ey: w.sy, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    if (tool) setGhost({ x: w.x, y: w.y });
    if (!drag) return;
    if (drag.kind === 'pan') {
      setView(v => ({ ...v, x: drag.vx - (e.clientX - drag.sx) / v.z, y: drag.vy - (e.clientY - drag.sy) / v.z }));
    } else if (drag.kind === 'lasso') {
      setDrag({ ...drag, ex: w.sx, ey: w.sy });
    } else if (drag.kind === 'body') {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      const b = map.bodies.find(x => x.id === drag.id);
      if (!b) return;
      let cx = 0, cy = 0;
      if (b.parent !== 'sun') {
        const p = map.bodies.find(x => x.id === b.parent);
        const pp = p ? pos.get(p.id)! : { x: 0, y: 0 };
        cx = pp.x; cy = pp.y;
      }
      const d = Math.hypot(w.x - cx, w.y - cy);
      const angle = Math.atan2(w.y - cy, w.x - cx);
      onMove(b.id, displayToOrbit(map, b.parent, d, scale), angle, drag.moved ? 'move' : 'start');
      if (!drag.moved) setDrag({ ...drag, moved: true });
    }
  };

  const onPointerUp = () => {
    if (drag?.kind === 'body' && drag.moved) {
      const b = map.bodies.find(x => x.id === drag.id);
      if (b) onMove(b.id, b.orbit, b.angle, 'end');
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

  const ghostHost = tool === 'moon' && ghost ? moonHostAt(ghost.x, ghost.y) : null;
  const sunOrbits = map.bodies.filter(b => b.parent === 'sun' && b.type !== 'asteroid' && b.type !== 'rock');

  return (
    <div
      ref={wrapRef}
      className={`mm-map${tool ? ' is-placing' : ''}${drag?.kind === 'pan' || spaceDown ? ' is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setGhost(null)}
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
        </defs>
        <g transform={`translate(${size.w / 2 - view.x * z} ${size.h / 2 - view.y * z}) scale(${z})`}>
          {sunOrbits.map(b => (
            <circle key={`o_${b.id}`} r={orbitToDisplay(map, b, scale)} className={`mm-orbit${selection.has(b.id) ? ' is-sel' : ''}`} />
          ))}
          {map.bodies.filter(b => b.parent !== 'sun').map(b => {
            const p = pos.get(b.parent);
            return p ? <circle key={`mo_${b.id}`} cx={p.x} cy={p.y} r={orbitToDisplay(map, b, scale)} className="mm-orbit is-moon" /> : null;
          })}

          {/* the sun */}
          <circle r={sunR(map) * 2.4} fill="url(#mm_sunglow)" pointerEvents="none" />
          <g data-body="sun" className="mm-body">
            <circle r={sunR(map)} fill={`url(#${gid(map.sun.color)})`} />
            {selection.has('sun') && <circle r={sunR(map) + px(6)} className="mm-sel" />}
          </g>
          <text y={sunR(map) + px(16)} className="mm-label is-sun" fontSize={px(11)}>{map.sun.name.toUpperCase()}</text>

          {map.bodies.map(b => {
            const p = pos.get(b.id)!;
            const r = discR(b);
            const sel = selection.has(b.id);
            const gas = b.surface === 'gas' || b.surface === 'storm';
            return (
              <g key={b.id} data-body={b.id} className="mm-body" transform={`translate(${p.x} ${p.y})`}>
                <circle r={Math.max(r, px(9))} fill="transparent" />
                {b.rings && <ellipse rx={r * 1.95} ry={r * 0.55} className="mm-ring" transform="rotate(-18)" />}
                {b.type === 'rock'
                  ? <path d={`M${-r} ${r * 0.2} L${-r * 0.3} ${-r * 0.8} L${r * 0.8} ${-r * 0.4} L${r} ${r * 0.5} L${r * 0.1} ${r * 0.9} Z`} fill={b.color} />
                  : <circle r={r} fill={`url(#${gid(b.color)})`} />}
                {gas && (
                  <g clipPath={undefined} opacity="0.35">
                    <ellipse rx={r * 0.92} ry={r * 0.12} cy={-r * 0.35} fill={shade(b.color, -0.4)} />
                    <ellipse rx={r * 0.98} ry={r * 0.1} cy={r * 0.15} fill={shade(b.color, 0.35)} />
                    <ellipse rx={r * 0.8} ry={r * 0.09} cy={r * 0.55} fill={shade(b.color, -0.3)} />
                  </g>
                )}
                {sel && <circle r={r + px(6)} className="mm-sel" />}
                {b.secret && (
                  <g transform={`translate(${r * 0.8 + px(3)} ${-r * 0.8 - px(3)})`}>
                    <circle r={px(6)} className="mm-badge is-secret" />
                    <text className="mm-badge__t" fontSize={px(8)} dy={px(3)}>?</text>
                  </g>
                )}
                {b.type !== 'asteroid' && b.type !== 'rock' && (z * r > 2.5 || sel) && (
                  <text y={r + px(13)} className={`mm-label${b.start ? ' is-start' : ''}${sel ? ' is-sel' : ''}`} fontSize={px(b.parent === 'sun' ? 10.5 : 9)}>
                    {b.name.toUpperCase()}{b.start ? ' ✦' : ''}
                  </text>
                )}
              </g>
            );
          })}

          {tool && ghost && (
            tool === 'moon'
              ? (ghostHost
                ? <circle cx={ghost.x} cy={ghost.y} r={discR({ type: 'moon', radius: 1.5 })} className="mm-ghost" />
                : <circle cx={ghost.x} cy={ghost.y} r={px(10)} className="mm-ghost is-bad" />)
              : tool === 'belt'
                ? <circle r={Math.hypot(ghost.x, ghost.y)} className="mm-ghost is-belt" />
                : <circle cx={ghost.x} cy={ghost.y} r={discR({ type: tool, radius: tool === 'gas-giant' ? 8 : tool === 'ice-giant' ? 5 : tool === 'terrestrial' ? 3 : 1.2 })} className="mm-ghost" />
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
      {tool && (
        <div className="mm-map__hint">
          {tool === 'moon' ? 'Click beside a planet to give it a moon' : tool === 'belt' ? 'Click where the belt should circle' : 'Click to place'} · Esc to stop
        </div>
      )}
    </div>
  );
};
