// ============================================================================
// MapEditor — move worlds, resize them, retune what they produce.
//
// SVG rather than canvas: the map is ~45 circles, hit-testing a click to a
// body is free, bodies are ordinary DOM nodes with hover and titles, and
// there is no imperative redraw to keep in sync with React state.
//
// SCALE. Orbits run from Mercury at 72 to Sedna at 7000, a 97x span. Drawn
// linearly the inner system collapses into the star and the planets
// everyone actually fights over become unclickable — so LOG is the
// default. But log spacing lies about distance, and distance is what
// travel time is made of, so there is a toggle: switch to linear when you
// need to judge how far apart two worlds really are, and zoom in to work
// there.
//
// Moons ride a small ring around their parent rather than their true
// orbital radius. Luna at 20 units next to Earth at 372 would render
// inside the planet's dot at any scale.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type CatalogBody = {
  id: string; name: string; type: string; parent: string | null;
  orbit_radius: number | null; radius: number; soi: number | null;
  yield_metal: number; yield_gold: number; yield_science: number; yield_fuel: number;
};
export type BodyField = {
  id: string; label: string; type: 'number' | 'int';
  min?: number; max?: number; step?: number; help?: string;
};
type Edits = Record<string, Record<string, number>>;

const W = 780, H = 560;
const CX = W / 2, CY = H / 2;
const R_MIN = 26, R_MAX = Math.min(W, H) / 2 - 30;
const ZOOM_MIN = 0.5, ZOOM_MAX = 12;

const TYPE_COLOR: Record<string, string> = {
  star: '#ffd180', terrestrial: '#4a90d9', 'gas-giant': '#e8b98a',
  'ice-giant': '#7fd4e8', moon: '#c0c0c0', dwarf: '#8b8b8b', asteroid: '#7a6d62',
};

const dim: React.CSSProperties = { fontSize: 11.5, color: '#8a9fb3', lineHeight: 1.5 };
const btn: React.CSSProperties = {
  background: 'rgba(20,28,40,.8)', border: '1px solid rgba(120,140,160,.35)',
  color: '#cdd9e4', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  padding: '3px 8px', lineHeight: 1.6,
};

export function MapEditor({
  catalog, fields, edits, onChange, onResetBody, onResetAll, readOnly,
  spawnRadiusFloor, spawnScienceFloor,
}: {
  catalog: CatalogBody[];
  fields: BodyField[];
  edits: Edits;
  onChange: (bodyId: string, field: string, value: number) => void;
  onResetBody: (bodyId: string) => void;
  onResetAll: () => void;
  readOnly: boolean;
  spawnRadiusFloor: number;
  spawnScienceFloor: number;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState<{ x: number; y: number } | null>(null);
  const [logScale, setLogScale] = useState(true);
  const [query, setQuery] = useState('');
  const [onlyEdited, setOnlyEdited] = useState(false);
  const [liveOrbit, setLiveOrbit] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const shipped = (b: CatalogBody, f: string): number =>
    (b as unknown as Record<string, number>)[f] ?? 0;
  /** Effective value = shipped catalogue with this draft's edits on top. */
  const val = useCallback((b: CatalogBody, f: string): number => {
    const e = edits[b.id]?.[f];
    return e !== undefined ? e : ((b as unknown as Record<string, number>)[f] ?? 0);
  }, [edits]);

  const heliocentric = useMemo(
    () => catalog.filter(b => b.type !== 'star' && b.parent === 'sol'), [catalog]);
  const moonsOf = useMemo(() => {
    const m = new Map<string, CatalogBody[]>();
    for (const b of catalog) {
      if (b.parent && b.parent !== 'sol') {
        const arr = m.get(b.parent) ?? []; arr.push(b); m.set(b.parent, arr);
      }
    }
    return m;
  }, [catalog]);

  // Scale fitted to the CURRENT extremes, so dragging a world outward
  // rescales the picture instead of pushing it off the edge.
  const { toPx, toOrbit } = useMemo(() => {
    const rs = heliocentric.map(b => Math.max(1, val(b, 'orbit_radius')));
    const lo = Math.min(...rs, 50), hi = Math.max(...rs, 100);
    if (logScale) {
      const l = Math.log(lo), h = Math.log(hi), span = Math.max(0.001, h - l);
      return {
        toPx: (o: number) => R_MIN + ((Math.log(Math.max(1, o)) - l) / span) * (R_MAX - R_MIN),
        toOrbit: (px: number) => Math.exp(l + ((px - R_MIN) / (R_MAX - R_MIN)) * span),
      };
    }
    const span = Math.max(1, hi - lo);
    return {
      toPx: (o: number) => R_MIN + ((Math.max(0, o) - lo) / span) * (R_MAX - R_MIN),
      toOrbit: (px: number) => lo + ((px - R_MIN) / (R_MAX - R_MIN)) * span,
    };
  }, [heliocentric, val, logScale]);

  /** Stable angle per body so the map does not reshuffle on every edit. */
  const angleOf = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return (h % 3600) / 3600 * Math.PI * 2;
  };
  const dotR = (b: CatalogBody) => Math.max(2.5, Math.min(16, Math.sqrt(val(b, 'radius')) * 4));

  const eligible = useCallback((b: CatalogBody) =>
    (b.type === 'terrestrial' || b.type === 'moon')
    && val(b, 'radius') >= spawnRadiusFloor
    && val(b, 'yield_science') >= spawnScienceFloor,
  [val, spawnRadiusFloor, spawnScienceFloor]);

  /** Screen point -> viewBox coords -> world coords (undo pan/zoom). */
  const toWorld = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const vx = (clientX - r.left) * (W / r.width);
    const vy = (clientY - r.top) * (H / r.height);
    return { x: (vx - pan.x) / zoom, y: (vy - pan.y) / zoom };
  };

  const onMove = (e: React.MouseEvent) => {
    if (panning) {
      setPan({ x: e.clientX - panning.x, y: e.clientY - panning.y });
      return;
    }
    if (!drag || readOnly || !svgRef.current) return;
    const w = toWorld(e.clientX, e.clientY);
    const px = Math.max(R_MIN, Math.min(R_MAX, Math.hypot(w.x - CX, w.y - CY)));
    const orbit = Math.round(toOrbit(px));
    setLiveOrbit(orbit);
    onChange(drag, 'orbit_radius', orbit);
  };

  // Wheel zoom, anchored on the cursor so you zoom into what you are
  // pointing at rather than into the middle of the canvas.
  //
  // Bound natively with passive:false rather than via onWheel: React may
  // register wheel handlers as passive, in which case preventDefault() is
  // silently ignored and the whole admin page scrolls away underneath you
  // while you try to zoom.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const vx = (e.clientX - r.left) * (W / r.width);
      const vy = (e.clientY - r.top) * (H / r.height);
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setPan({ x: vx - ((vx - pan.x) / zoom) * next, y: vy - ((vy - pan.y) / zoom) * next });
      setZoom(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoom, pan]);

  const zoomBy = (f: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * f));
    // Anchor on the canvas centre when using the buttons.
    setPan({ x: CX - ((CX - pan.x) / zoom) * next, y: CY - ((CY - pan.y) / zoom) * next });
    setZoom(next);
  };
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  /** Centre the view on a body and zoom in — the fast way to reach a moon
   *  buried next to its planet. */
  const focusOn = (b: CatalogBody) => {
    setSel(b.id);
    const parent = b.parent && b.parent !== 'sol' ? catalog.find(p => p.id === b.parent) : null;
    const anchor = parent ?? b;
    const a = angleOf(anchor.id);
    const rp = toPx(val(anchor, 'orbit_radius'));
    const x = CX + Math.cos(a) * rp, y = CY + Math.sin(a) * rp;
    const next = Math.max(zoom, 3);
    setZoom(next);
    setPan({ x: CX - x * next, y: CY - y * next });
  };

  // Keyboard: nudge the selected world's orbit, Esc to deselect. Shift for
  // coarse steps — the difference between fine-tuning Mars and dragging
  // Sedna halfway across the system.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSel(null); return; }
      if (!sel || readOnly) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const b = catalog.find(x => x.id === sel);
      if (!b || b.parent !== 'sol') return;
      const step = e.shiftKey ? 50 : 5;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault(); onChange(sel, 'orbit_radius', Math.round(val(b, 'orbit_radius') + step));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        onChange(sel, 'orbit_radius', Math.max(5, Math.round(val(b, 'orbit_radius') - step)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, catalog, onChange, val, readOnly]);

  const selBody = catalog.find(b => b.id === sel) ?? null;
  const editedIds = Object.keys(edits);

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog
      .filter(b => b.type !== 'star')
      .filter(b => (!q || b.name.toLowerCase().includes(q)))
      .filter(b => (!onlyEdited || edits[b.id]))
      .sort((a, b) => (a.orbit_radius ?? 0) - (b.orbit_radius ?? 0));
  }, [catalog, query, onlyEdited, edits]);

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {/* ---------------- map ---------------- */}
      <div style={{ flex: '1 1 480px', minWidth: 320 }}>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <button style={btn} onClick={() => zoomBy(1.4)} title="Zoom in">+</button>
          <button style={btn} onClick={() => zoomBy(1 / 1.4)} title="Zoom out">−</button>
          <button style={btn} onClick={resetView}>Reset view</button>
          <span style={{ ...dim, fontSize: 10.5, minWidth: 44 }}>{zoom.toFixed(1)}×</span>
          <button style={{ ...btn, borderColor: logScale ? '#4ecdc4' : 'rgba(120,140,160,.35)',
            color: logScale ? '#4ecdc4' : '#cdd9e4' }}
            onClick={() => setLogScale(s => !s)}
            title="Log keeps every orbit clickable; linear shows true relative distance">
            {logScale ? 'Log scale' : 'Linear scale'}
          </button>
          {editedIds.length > 0 && !readOnly && (
            <button style={{ ...btn, borderColor: '#ffb84d', color: '#ffb84d' }}
              onClick={() => { if (window.confirm(`Revert all ${editedIds.length} edited bodies to shipped values?`)) onResetAll(); }}>
              Revert map ({editedIds.length})
            </button>
          )}
        </div>

        <svg
          ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%"
          style={{
            background: 'radial-gradient(circle at 50% 50%, #0b1420, #070b12)',
            borderRadius: 8, border: '1px solid rgba(96,130,160,.3)',
            cursor: drag ? 'grabbing' : panning ? 'move' : 'default', touchAction: 'none',
          }}
          onMouseMove={onMove}
          onMouseUp={() => { setDrag(null); setPanning(null); setLiveOrbit(null); }}
          onMouseLeave={() => { setDrag(null); setPanning(null); setLiveOrbit(null); }}
          onMouseDown={e => {
            // Background drag pans. Body drags stopPropagation below.
            setPanning({ x: e.clientX - pan.x, y: e.clientY - pan.y });
          }}
        >
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {heliocentric.map(b => (
              <circle key={`o-${b.id}`} cx={CX} cy={CY} r={toPx(val(b, 'orbit_radius'))}
                fill="none" vectorEffect="non-scaling-stroke"
                stroke={edits[b.id] ? 'rgba(255,184,77,.3)' : 'rgba(120,150,180,.12)'} strokeWidth={1} />
            ))}
            <circle cx={CX} cy={CY} r={10} fill="#ffd180" opacity={0.9} />

            {heliocentric.map(b => {
              const a = angleOf(b.id);
              const rp = toPx(val(b, 'orbit_radius'));
              const x = CX + Math.cos(a) * rp, y = CY + Math.sin(a) * rp;
              const moons = moonsOf.get(b.id) ?? [];
              const isSel = sel === b.id;
              return (
                <g key={b.id}>
                  {moons.map((m, i) => {
                    const ma = a + 0.55 + (i * (Math.PI * 2)) / Math.max(1, moons.length);
                    const mr = dotR(b) + 9;
                    const mx = x + Math.cos(ma) * mr, my = y + Math.sin(ma) * mr;
                    return (
                      <circle key={m.id} cx={mx} cy={my} r={dotR(m)}
                        fill={TYPE_COLOR[m.type] ?? '#999'} vectorEffect="non-scaling-stroke"
                        stroke={sel === m.id ? '#4ecdc4' : eligible(m) ? '#6ee7b7' : edits[m.id] ? '#ffb84d' : 'none'}
                        strokeWidth={sel === m.id ? 2 : 1.5}
                        style={{ cursor: 'pointer' }}
                        onMouseDown={e => { e.stopPropagation(); setSel(m.id); }}
                      ><title>{m.name}</title></circle>
                    );
                  })}
                  <circle
                    cx={x} cy={y} r={dotR(b)} fill={TYPE_COLOR[b.type] ?? '#999'}
                    vectorEffect="non-scaling-stroke"
                    stroke={isSel ? '#4ecdc4' : eligible(b) ? '#6ee7b7' : edits[b.id] ? '#ffb84d' : 'rgba(255,255,255,.25)'}
                    strokeWidth={isSel ? 2.5 : 1.5}
                    style={{ cursor: readOnly ? 'pointer' : 'grab' }}
                    onMouseDown={e => { e.stopPropagation(); setSel(b.id); if (!readOnly) setDrag(b.id); }}
                  ><title>{b.name} — orbit {Math.round(val(b, 'orbit_radius'))}</title></circle>
                  {(dotR(b) >= 5 || isSel) && (
                    <text x={x} y={y - dotR(b) - 4} textAnchor="middle"
                      fill={isSel ? '#4ecdc4' : '#8a9fb3'} fontSize={9.5 / Math.max(1, zoom * 0.55)}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>{b.name}</text>
                  )}
                </g>
              );
            })}
          </g>

          {/* Live readout while dragging — you are setting a NUMBER, and
              guessing it from a dot's position is how you end up with a
              world at 903 when you meant 900. */}
          {drag && liveOrbit != null && (
            <g>
              <rect x={10} y={H - 32} width={168} height={22} rx={4} fill="rgba(10,16,24,.85)" stroke="#4ecdc4" />
              <text x={18} y={H - 17} fill="#4ecdc4" fontSize={12}
                fontFamily="ui-monospace, Menlo, Consolas, monospace">
                orbit {liveOrbit}
              </text>
            </g>
          )}
        </svg>

        <div style={{ ...dim, marginTop: 6 }}>
          {readOnly ? 'Read-only — clone this config to edit. ' : 'Drag a world to move it · scroll to zoom · drag background to pan · arrow keys nudge (shift = ×10) · Esc deselects. '}
          <span style={{ color: '#6ee7b7' }}>green</span> = can be a capital ·{' '}
          <span style={{ color: '#ffb84d' }}>amber</span> = edited
        </div>
      </div>

      {/* ---------------- side panel ---------------- */}
      <div style={{ flex: '0 1 264px', minWidth: 236, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* finder */}
        <div>
          <input
            value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a world…"
            style={{
              width: '100%', padding: '5px 8px', borderRadius: 5, boxSizing: 'border-box',
              background: 'rgba(10,16,24,.7)', color: '#e7eef6',
              border: '1px solid rgba(120,140,160,.35)', fontSize: 12,
            }}
          />
          <label style={{ ...dim, display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
            <input type="checkbox" checked={onlyEdited} onChange={e => setOnlyEdited(e.target.checked)} />
            edited only
          </label>
          <div style={{ maxHeight: 148, overflowY: 'auto', marginTop: 5,
            border: '1px solid rgba(96,130,160,.22)', borderRadius: 5 }}>
            {listed.map(b => (
              <button key={b.id} onClick={() => focusOn(b)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                  background: sel === b.id ? 'rgba(78,205,196,.12)' : 'transparent',
                  border: 'none', borderBottom: '1px solid rgba(96,130,160,.12)',
                  color: '#cdd9e4', cursor: 'pointer', padding: '4px 7px', fontSize: 11.5,
                }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%',
                  background: TYPE_COLOR[b.type] ?? '#999', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{b.name}</span>
                {eligible(b) && <span style={{ color: '#6ee7b7', fontSize: 10 }}>cap</span>}
                {edits[b.id] && <span style={{ color: '#ffb84d', fontSize: 10 }}>●</span>}
              </button>
            ))}
            {!listed.length && <div style={{ ...dim, padding: '6px 7px' }}>No matches.</div>}
          </div>
        </div>

        {/* inspector */}
        {!selBody ? (
          <div style={dim}>Select a body to edit its position, size and yields.</div>
        ) : (
          <div style={{ border: '1px solid rgba(96,130,160,.3)', borderRadius: 8, padding: '11px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 11, height: 11, borderRadius: '50%',
                background: TYPE_COLOR[selBody.type] ?? '#999' }} />
              <b style={{ fontSize: 13, color: '#cdd9e4', flex: 1 }}>{selBody.name}</b>
              {edits[selBody.id] && !readOnly && (
                <button style={{ ...btn, fontSize: 10, padding: '2px 6px', borderColor: '#ffb84d', color: '#ffb84d' }}
                  onClick={() => onResetBody(selBody.id)}>revert</button>
              )}
            </div>
            <div style={{ ...dim, fontSize: 10.5 }}>{selBody.type}</div>
            <div style={{ fontSize: 11, color: eligible(selBody) ? '#6ee7b7' : '#7d8fa3', marginTop: 3 }}>
              {eligible(selBody)
                ? 'Eligible as a starting capital.'
                : selBody.type === 'terrestrial' || selBody.type === 'moon'
                  ? `Not a capital: needs radius ≥ ${spawnRadiusFloor} and science ≥ ${spawnScienceFloor}.`
                  : 'Not a capital: only planets and moons qualify.'}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 10 }}>
              {fields.map(f => {
                const v = val(selBody, f.id);
                const base = shipped(selBody, f.id);
                const isEdited = edits[selBody.id]?.[f.id] !== undefined;
                return (
                  <div key={f.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11.5, color: '#cdd9e4', flex: 1 }}>{f.label}</span>
                      <input
                        type="number" value={String(v)} disabled={readOnly}
                        min={f.min} max={f.max} step={f.step ?? (f.type === 'int' ? 1 : 0.1)}
                        onChange={e => onChange(selBody.id, f.id, Number(e.target.value))}
                        style={{
                          width: 82, padding: '3px 6px', borderRadius: 4,
                          background: 'rgba(10,16,24,.7)', color: '#e7eef6',
                          border: `1px solid ${isEdited ? '#ffb84d' : 'rgba(120,140,160,.35)'}`,
                          fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5,
                        }}
                      />
                    </div>
                    {/* Always show what shipped, so a change is legible as a
                        CHANGE rather than just a number sitting in a box. */}
                    {isEdited && (
                      <div style={{ fontSize: 10.5, color: '#ffb84d', marginTop: 1 }}>
                        was {base}
                        <button onClick={() => onChange(selBody.id, f.id, base)}
                          style={{ background: 'none', border: 'none', color: '#8a9fb3', cursor: 'pointer',
                            fontSize: 10.5, textDecoration: 'underline', padding: '0 0 0 6px' }}>
                          undo
                        </button>
                      </div>
                    )}
                    {f.help && !isEdited && (
                      <div style={{ ...dim, fontSize: 10.5, marginTop: 1 }}>{f.help}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
