// ============================================================================
// MapEditor — move worlds, resize them, retune what they produce.
//
// Rendered as SVG rather than canvas on purpose: hit-testing a click to a
// body is free, bodies are ordinary DOM nodes with hover and focus, and
// there is no imperative redraw to keep in sync with React state. The map
// is ~45 circles; canvas would buy nothing and cost all of that.
//
// LOG RADIAL SCALE. Orbits run from Mercury at 72 to Sedna at 7000, a
// 97x span. Drawn linearly the inner system collapses into the star and
// the four planets everybody actually fights over become unclickable.
// Log spacing keeps every orbit reachable at the cost of the picture no
// longer being to scale — which is the right trade for an EDITOR, where
// the job is grabbing a specific world, not admiring the geometry.
//
// Moons are drawn on a small ring around their parent rather than at
// their true orbital radius, for the same reason: Luna at 20 units next
// to Earth at 186 would be inside the planet's dot.
// ============================================================================

import React, { useMemo, useRef, useState } from 'react';

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

const W = 760, H = 520;
const CX = W / 2, CY = H / 2;
const R_MIN = 26, R_MAX = Math.min(W, H) / 2 - 34;

const TYPE_COLOR: Record<string, string> = {
  star: '#ffd180', terrestrial: '#4a90d9', 'gas-giant': '#e8b98a',
  'ice-giant': '#7fd4e8', moon: '#c0c0c0', dwarf: '#8b8b8b', asteroid: '#7a6d62',
};

const dim: React.CSSProperties = { fontSize: 11.5, color: '#8a9fb3', lineHeight: 1.5 };

export function MapEditor({
  catalog, fields, edits, onChange, readOnly, spawnRadiusFloor, spawnScienceFloor,
}: {
  catalog: CatalogBody[];
  fields: BodyField[];
  edits: Edits;
  onChange: (bodyId: string, field: string, value: number) => void;
  readOnly: boolean;
  spawnRadiusFloor: number;
  spawnScienceFloor: number;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  /** Effective value = shipped catalogue with this draft's edits on top. */
  const val = (b: CatalogBody, f: string): number => {
    const e = edits[b.id]?.[f];
    if (e !== undefined) return e;
    return (b as unknown as Record<string, number>)[f] ?? 0;
  };

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

  // Log scale fitted to the CURRENT extremes, so dragging a world outward
  // rescales the whole picture instead of pushing it off the edge.
  const { toPx, toOrbit } = useMemo(() => {
    const rs = heliocentric.map(b => Math.max(1, val(b, 'orbit_radius')));
    const lo = Math.log(Math.min(...rs, 50));
    const hi = Math.log(Math.max(...rs, 100));
    const span = Math.max(0.001, hi - lo);
    return {
      toPx: (orbit: number) => R_MIN + ((Math.log(Math.max(1, orbit)) - lo) / span) * (R_MAX - R_MIN),
      toOrbit: (px: number) => Math.exp(lo + ((px - R_MIN) / (R_MAX - R_MIN)) * span),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heliocentric, edits]);

  // Stable angle per body so the map does not reshuffle on every edit.
  const angleOf = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return (h % 3600) / 3600 * Math.PI * 2;
  };

  const dotR = (b: CatalogBody) => Math.max(2.5, Math.min(16, Math.sqrt(val(b, 'radius')) * 4));

  const eligible = (b: CatalogBody) =>
    (b.type === 'terrestrial' || b.type === 'moon')
    && val(b, 'radius') >= spawnRadiusFloor
    && val(b, 'yield_science') >= spawnScienceFloor;

  const onMove = (e: React.MouseEvent) => {
    if (!drag || readOnly || !svgRef.current) return;
    const pt = svgRef.current.getBoundingClientRect();
    const dx = e.clientX - pt.left - CX;
    const dy = e.clientY - pt.top - CY;
    const px = Math.max(R_MIN, Math.min(R_MAX, Math.hypot(dx, dy)));
    onChange(drag, 'orbit_radius', Math.round(toOrbit(px)));
  };

  const selBody = catalog.find(b => b.id === sel) ?? null;

  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 520px', minWidth: 340 }}>
        <svg
          ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%"
          style={{ background: 'radial-gradient(circle at 50% 50%, #0b1420, #070b12)',
            borderRadius: 8, border: '1px solid rgba(96,130,160,.3)', cursor: drag ? 'grabbing' : 'default' }}
          onMouseMove={onMove}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}
        >
          {/* orbit rings */}
          {heliocentric.map(b => (
            <circle key={`o-${b.id}`} cx={CX} cy={CY} r={toPx(val(b, 'orbit_radius'))}
              fill="none" stroke={edits[b.id] ? 'rgba(255,184,77,.25)' : 'rgba(120,150,180,.12)'} strokeWidth={1} />
          ))}

          {/* star */}
          <circle cx={CX} cy={CY} r={10} fill="#ffd180" opacity={0.9} />

          {heliocentric.map(b => {
            const a = angleOf(b.id);
            const rp = toPx(val(b, 'orbit_radius'));
            const x = CX + Math.cos(a) * rp, y = CY + Math.sin(a) * rp;
            const moons = moonsOf.get(b.id) ?? [];
            const isSel = sel === b.id;
            const edited = !!edits[b.id];
            return (
              <g key={b.id}>
                {moons.map((m, i) => {
                  const ma = a + 0.55 + (i * (Math.PI * 2)) / Math.max(1, moons.length);
                  const mr = dotR(b) + 9;
                  const mx = x + Math.cos(ma) * mr, my = y + Math.sin(ma) * mr;
                  return (
                    <circle key={m.id} cx={mx} cy={my} r={dotR(m)}
                      fill={TYPE_COLOR[m.type] ?? '#999'}
                      stroke={sel === m.id ? '#4ecdc4' : eligible(m) ? '#6ee7b7' : edits[m.id] ? '#ffb84d' : 'none'}
                      strokeWidth={sel === m.id ? 2 : 1.5}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSel(m.id)}
                    >
                      <title>{m.name}</title>
                    </circle>
                  );
                })}
                <circle
                  cx={x} cy={y} r={dotR(b)}
                  fill={TYPE_COLOR[b.type] ?? '#999'}
                  stroke={isSel ? '#4ecdc4' : eligible(b) ? '#6ee7b7' : edited ? '#ffb84d' : 'rgba(255,255,255,.25)'}
                  strokeWidth={isSel ? 2.5 : 1.5}
                  style={{ cursor: readOnly ? 'pointer' : 'grab' }}
                  onMouseDown={() => { setSel(b.id); if (!readOnly) setDrag(b.id); }}
                  onClick={() => setSel(b.id)}
                >
                  <title>{b.name} — orbit {Math.round(val(b, 'orbit_radius'))}</title>
                </circle>
                {(dotR(b) >= 5 || isSel) && (
                  <text x={x} y={y - dotR(b) - 4} textAnchor="middle"
                    fill={isSel ? '#4ecdc4' : '#8a9fb3'} fontSize={9.5}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}>{b.name}</text>
                )}
              </g>
            );
          })}
        </svg>
        <div style={{ ...dim, marginTop: 6 }}>
          {readOnly ? 'Read-only — clone this config to edit.' : 'Drag a world to change its orbit. Click any body to edit it.'}
          {' '}<span style={{ color: '#6ee7b7' }}>green ring</span> = can be a capital ·{' '}
          <span style={{ color: '#ffb84d' }}>amber</span> = edited ·
          {' '}log scale, so spacing is readable rather than true.
        </div>
      </div>

      {/* inspector */}
      <div style={{ flex: '0 1 260px', minWidth: 230 }}>
        {!selBody ? (
          <div style={dim}>Select a body to edit its position, size and yields.</div>
        ) : (
          <div style={{ border: '1px solid rgba(96,130,160,.3)', borderRadius: 8, padding: '11px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 11, height: 11, borderRadius: '50%',
                background: TYPE_COLOR[selBody.type] ?? '#999', display: 'inline-block' }} />
              <b style={{ fontSize: 13, color: '#cdd9e4' }}>{selBody.name}</b>
              <span style={{ ...dim, fontSize: 10.5 }}>{selBody.type}</span>
            </div>
            {eligible(selBody) && (
              <div style={{ fontSize: 11, color: '#6ee7b7', marginTop: 3 }}>
                Eligible as a starting capital.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 10 }}>
              {fields.map(f => {
                const v = val(selBody, f.id);
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
                          width: 84, padding: '3px 6px', borderRadius: 4,
                          background: 'rgba(10,16,24,.7)', color: '#e7eef6',
                          border: `1px solid ${isEdited ? '#ffb84d' : 'rgba(120,140,160,.35)'}`,
                          fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5,
                        }}
                      />
                    </div>
                    {f.help && <div style={{ ...dim, fontSize: 10.5, marginTop: 1 }}>{f.help}</div>}
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
