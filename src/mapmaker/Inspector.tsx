// The Map Maker's right-hand panel: one world (World / Look / Secrets),
// the sun, or -- with a group selected -- the bulk bar along the bottom.

import React, { useState } from 'react';
import {
  type CustomMap, type MapBody, type MapBodyType, type MapSecret,
  TYPE_INFO, SURFACES, MAP_SECRETS, NAME_THEMES, RESOURCE_MAX, SUN_LIMITS,
  canStartOn, secretFits, bodyYear, makeName, startWorlds,
} from '../game/customMap';
import { SECRET_DEFS } from '../game/secrets';
import {
  PRESETS, addMoon, changeType, deleteBodies, duplicateBodies, updateBodies, bulkResources,
  spaceEvenly, renameByTheme, recolor, markStart, setSecret, scaleSize, colorForSurface, takenNames,
  type ResMode, type ResKey,
} from './ops';

type Change = (next: CustomMap, select?: string[]) => void;

const RES: Array<{ key: ResKey; label: string; cls: string }> = [
  { key: 'metal', label: 'Metal', cls: 'is-metal' },
  { key: 'credits', label: 'Credits', cls: 'is-credits' },
  { key: 'science', label: 'Science', cls: 'is-science' },
];
const SWATCHES = ['#4f8a3c', '#2f8fd6', '#c9a36b', '#9a8a78', '#a0a6ad', '#cfe8f2', '#d65a2a', '#9ab83c', '#d4a574', '#73c2d6', '#c1440e', '#8a6bbf'];
const STAR_SWATCHES = [
  { c: '#ffd180', label: 'Yellow sun' }, { c: '#fff1d6', label: 'White sun' },
  { c: '#ff9b5e', label: 'Orange sun' }, { c: '#a9c8ff', label: 'Blue giant' },
];
const SURFACE_LABEL: Record<string, string> = {
  verdant: 'Verdant', ocean: 'Ocean', desert: 'Desert', rocky: 'Rocky', barren: 'Barren',
  ice: 'Ice', lava: 'Lava', toxic: 'Toxic', gas: 'Gas bands', storm: 'Storms',
};
const TYPES_FOR_SUN: MapBodyType[] = ['terrestrial', 'gas-giant', 'ice-giant', 'dwarf', 'asteroid', 'rock'];

export function secretName(kind: string): string {
  if (kind === 'random') return 'Left to chance';
  return (SECRET_DEFS as Record<string, { displayName: string }>)[kind]?.displayName ?? kind.replace(/_/g, ' ');
}

const SECRET_HINT: Record<string, string> = {
  random: 'A discovery the seed picks when the game starts. Nobody knows which until a ship parks here.',
  ancient_city: 'A free city with a working Lab, for the first to park here.',
  pre_terraformed: 'Already terraformed: whoever claims it can build cities at once.',
  derelict_warship: 'A destroyer for the finder, as modern as their own yards build.',
  resource_cache: '+500 metal and +500 credits for the finder.',
  ancient_databank: 'A free research level for the finder.',
  ancient_capital: 'A derelict capital ship: a Mega Destroyer or a Mobile Foundry.',
  ancient_relay: 'An ancient sensor relay. Breach and seize it to see what it sees.',
  ancient_station: 'An ancient weapons station that fires on everyone until it is seized.',
  deep_cache: 'A cache worth a destroyer in metal and credits.',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mm-field"><span className="mm-field__l">{label}</span>{children}</label>;
}

function Slider({ value, min, max, step = 1, onChange, onCommit, label }: {
  value: number; min: number; max: number; step?: number; label: string;
  onChange: (v: number) => void; onCommit?: () => void;
}) {
  return (
    <input
      type="range" className="mm-range" min={min} max={max} step={step} value={value} aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit}
    />
  );
}

/** One world. */
export const BodyInspector: React.FC<{
  map: CustomMap; body: MapBody; theme: string; onChange: Change; onTransient: (m: CustomMap) => void;
}> = ({ map, body, theme, onChange, onTransient }) => {
  const [tab, setTab] = useState<'world' | 'look' | 'secrets'>('world');
  const info = TYPE_INFO[body.type];
  const patch = (p: Partial<MapBody>) => onChange(updateBodies(map, [body.id], () => p));
  const live = (p: Partial<MapBody>) => onTransient(updateBodies(map, [body.id], () => p));
  const moons = map.bodies.filter(b => b.parent === body.id);
  const parent = body.parent === 'sun' ? null : map.bodies.find(b => b.id === body.parent);
  const year = Math.round(bodyYear(map, body));
  const st = startWorlds(map);
  const typeChoices: MapBodyType[] = body.type === 'moon' ? ['moon', ...TYPES_FOR_SUN] : TYPES_FOR_SUN;

  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <span className="mm-insp__disc" style={{ background: `radial-gradient(circle at 35% 32%, #fff8, ${body.color} 55%, #0008)` }} />
        <div className="mm-insp__id">
          <input
            className="mm-insp__name" value={body.name} aria-label="World name" maxLength={24}
            onChange={(e) => live({ name: e.target.value })}
            onBlur={(e) => patch({ name: e.target.value })}
          />
          <span className="mm-insp__sub">
            {info.label}{parent ? ` · moon of ${parent.name}` : ` · orbits ${map.sun.name}`}
          </span>
        </div>
        <button
          className="mm-icon" aria-label="Random name" title="Random name"
          onClick={() => {
            const taken = takenNames(map);
            taken.delete(body.name.toLowerCase());
            patch({ name: makeName(theme, taken, Math.random, 0, map.sun.name) });
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.2" /><circle cx="16" cy="16" r="1.2" /><circle cx="12" cy="12" r="1.2" /></svg>
        </button>
      </div>

      <div className="mm-tabs" role="tablist">
        {(['world', 'look', 'secrets'] as const).map(t => (
          <button key={t} role="tab" aria-selected={tab === t} className={`mm-chip${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {t === 'world' ? 'World' : t === 'look' ? 'Look' : 'Secrets'}
          </button>
        ))}
      </div>

      {tab === 'world' && (
        <div className="mm-insp__body">
          {body.type === 'rock' ? (
            <>
              <div className="mm-sec">ORE</div>
              <div className="mm-row">
                {(['metal', 'gold'] as const).map(k => (
                  <button key={k} className={`mm-chip${body.mineral?.kind === k ? ' is-on' : ''}`} onClick={() => patch({ mineral: { kind: k, tons: body.mineral?.tons ?? 1200 } })}>
                    {k === 'metal' ? 'Metal' : 'Credits (gold)'}
                  </button>
                ))}
              </div>
              <Field label={`TONNAGE · ${body.mineral?.tons ?? 0}`}>
                <Slider label="Tonnage" value={body.mineral?.tons ?? 1200} min={200} max={5000} step={25}
                  onChange={(v) => live({ mineral: { kind: body.mineral?.kind ?? 'metal', tons: v } })}
                  onCommit={() => onChange(map)} />
              </Field>
              <p className="mm-note">A rock is mined, not settled: ships with mining rigs haul its ore home until it runs out. Players find rocks with their sensors.</p>
            </>
          ) : (
            <>
              <div className="mm-sec mm-sec--row"><span>RESOURCES PER TICK</span></div>
              {RES.map(r => (
                <div key={r.key} className="mm-res">
                  <span className={`mm-res__l ${r.cls}`}>{r.label}</span>
                  <Slider label={r.label} value={body.yields[r.key]} min={0} max={RESOURCE_MAX}
                    onChange={(v) => live({ yields: { ...body.yields, [r.key]: v } })}
                    onCommit={() => onChange(map)} />
                  <input
                    className="mm-num" type="number" min={0} max={RESOURCE_MAX} value={body.yields[r.key]} aria-label={`${r.label} per tick`}
                    onChange={(e) => patch({ yields: { ...body.yields, [r.key]: Number(e.target.value) } })}
                  />
                </div>
              ))}
              <div className="mm-row mm-row--wrap">
                {PRESETS.map(p => (
                  <button key={p.label} className="mm-chip is-small" onClick={() => patch({ yields: { ...p.y } })}>{p.label}</button>
                ))}
              </div>
            </>
          )}

          <div className="mm-grid2">
            <Field label="ORBIT DISTANCE">
              <input className="mm-input" type="number" value={Math.round(body.orbit)} min={1}
                onChange={(e) => patch({ orbit: Number(e.target.value) })} />
            </Field>
            <Field label="YEAR">
              <input className="mm-input is-ro" readOnly value={`${year} ticks`} />
            </Field>
            <Field label={`SIZE · ${body.radius.toFixed(1)}`}>
              <Slider label="Size" value={body.radius} min={info.radius[0]} max={info.radius[1]} step={0.1}
                onChange={(v) => live({ radius: v })} onCommit={() => onChange(map)} />
            </Field>
            <Field label="TYPE">
              <select className="mm-input" value={body.type} onChange={(e) => onChange(changeType(map, body.id, e.target.value as MapBodyType))}>
                {typeChoices.map(t => <option key={t} value={t}>{TYPE_INFO[t].label}</option>)}
              </select>
            </Field>
          </div>

          {canStartOn(body.type) && (
            <div className="mm-box">
              <label className="mm-check">
                <input type="checkbox" checked={!!body.start} onChange={(e) => patch({ start: e.target.checked })} />
                <span>Players may start here</span>
                {body.start && <span className="mm-tag is-start">✦ START</span>}
              </label>
              <p className="mm-note">
                {st.marked
                  ? `${st.worlds.length} start world${st.worlds.length === 1 ? '' : 's'} marked: a game on this map seats up to ${Math.min(10, st.worlds.length)}.`
                  : 'None marked yet, so the game picks: medium-size worlds or bigger with science 2+.'}
              </p>
            </div>
          )}

          {body.parent === 'sun' && body.type !== 'asteroid' && body.type !== 'rock' && (
            <div>
              <div className="mm-sec">MOONS</div>
              <div className="mm-row mm-row--wrap">
                {moons.map(m => <span key={m.id} className="mm-pill">{m.name}</span>)}
                <button className="mm-chip is-dashed" onClick={() => { const r = addMoon(map, body.id, theme); onChange(r.map, [body.id]); }}>+ Add moon</button>
              </div>
            </div>
          )}

          <div className="mm-row mm-row--end">
            <button className="mm-btn" onClick={() => { const r = duplicateBodies(map, [body.id], theme); onChange(r.map, r.ids); }}>Duplicate</button>
            <button className="mm-btn is-danger" onClick={() => onChange(deleteBodies(map, [body.id]), [])}>Delete</button>
          </div>
        </div>
      )}

      {tab === 'look' && (
        <div className="mm-insp__body">
          <div className="mm-sec">COLOUR</div>
          <div className="mm-swatches">
            {SWATCHES.map(c => (
              <button key={c} className={`mm-swatch${body.color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => patch({ color: c })} />
            ))}
            <input type="color" className="mm-swatch is-custom" value={body.color} aria-label="Pick any colour" onChange={(e) => live({ color: e.target.value })} onBlur={() => onChange(map)} />
          </div>
          {body.type !== 'rock' && (
            <>
              <div className="mm-sec">SURFACE</div>
              <div className="mm-row mm-row--wrap">
                {SURFACES.map(s => (
                  <button key={s} className={`mm-chip is-small${body.surface === s ? ' is-on' : ''}`}
                    onClick={() => patch({ surface: s, color: colorForSurface(s, body.color) })}>
                    {SURFACE_LABEL[s]}
                  </button>
                ))}
              </div>
              <p className="mm-note">Living surfaces (verdant, ocean, desert, ice, lava, toxic) also set how the world looks once someone terraforms it.</p>
            </>
          )}
          {(body.type === 'gas-giant' || body.type === 'ice-giant' || body.type === 'terrestrial') && (
            <label className="mm-check">
              <input type="checkbox" checked={!!body.rings} onChange={(e) => patch({ rings: e.target.checked })} />
              <span>Rings</span>
            </label>
          )}
        </div>
      )}

      {tab === 'secrets' && (
        <div className="mm-insp__body">
          {body.type === 'rock' ? (
            <p className="mm-note">Rocks hide no discoveries. Their ore is the prize.</p>
          ) : (
            <>
              <div className="mm-sec">HIDDEN DISCOVERY</div>
              <p className="mm-note">Revealed to the first empire to park a ship here.</p>
              <div className="mm-secret-list">
                {([null, 'random', ...MAP_SECRETS] as Array<MapSecret | 'random' | null>).map(k => {
                  const fits = secretFits(k, body.type);
                  const on = (body.secret ?? null) === k;
                  return (
                    <button
                      key={k ?? 'none'} disabled={!fits || (!!body.start && !!k)}
                      className={`mm-secret${on ? ' is-on' : ''}`}
                      onClick={() => patch({ secret: k })}
                    >
                      <span className="mm-secret__n">{k ? secretName(k) : 'Nothing hidden'}</span>
                      {k && <span className="mm-secret__d">{SECRET_HINT[k]}</span>}
                    </button>
                  );
                })}
              </div>
              {body.start && <p className="mm-note">Start worlds hide nothing: whoever starts here would get it for free.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/** The sun. */
export const SunInspector: React.FC<{ map: CustomMap; onChange: Change; onTransient: (m: CustomMap) => void }> = ({ map, onChange, onTransient }) => {
  const set = (p: Partial<CustomMap['sun']>) => onChange({ ...map, sun: { ...map.sun, ...p } });
  const live = (p: Partial<CustomMap['sun']>) => onTransient({ ...map, sun: { ...map.sun, ...p } });
  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <span className="mm-insp__disc" style={{ background: `radial-gradient(circle at 40% 38%, #fff, ${map.sun.color} 45%, #c2531c)` }} />
        <div className="mm-insp__id">
          <input className="mm-insp__name" value={map.sun.name} aria-label="Sun name" maxLength={24}
            onChange={(e) => live({ name: e.target.value })} onBlur={(e) => set({ name: e.target.value })} />
          <span className="mm-insp__sub">The star at the heart of the system</span>
        </div>
      </div>
      <div className="mm-insp__body">
        <div className="mm-sec">STAR</div>
        <div className="mm-row mm-row--wrap">
          {STAR_SWATCHES.map(s => (
            <button key={s.c} className={`mm-chip${map.sun.color === s.c ? ' is-on' : ''}`} onClick={() => set({ color: s.c })}>
              <span className="mm-dot" style={{ background: s.c }} />{s.label}
            </button>
          ))}
        </div>
        <Field label={`SIZE · ${Math.round(map.sun.size)}`}>
          <Slider label="Sun size" value={map.sun.size} min={SUN_LIMITS.size[0]} max={SUN_LIMITS.size[1]} onChange={(v) => live({ size: v })} onCommit={() => onChange(map)} />
        </Field>
        <Field label={`MASS · ×${map.sun.mass.toFixed(2)}`}>
          <Slider label="Sun mass" value={map.sun.mass} min={SUN_LIMITS.mass[0]} max={SUN_LIMITS.mass[1]} step={0.05} onChange={(v) => live({ mass: v })} onCommit={() => onChange(map)} />
        </Field>
        <p className="mm-note">A heavier sun swings its worlds round faster: shorter years, more motion on the map. A lighter one slows the whole system down.</p>
      </div>
    </div>
  );
};

/** Nothing selected: what to do next. */
export const EmptyInspector: React.FC<{ map: CustomMap }> = ({ map }) => (
  <div className="mm-insp">
    <div className="mm-insp__body">
      <div className="mm-sec">GETTING STARTED</div>
      <ol className="mm-steps">
        <li>Pick something on the left, then click the map to place it.</li>
        <li>Click a world to name it, shape it and set what it yields.</li>
        <li>Drag a world to move it. Drag empty space to select a group, then change them all at once.</li>
        <li>Mark where players start, hide a few discoveries, and check the list at the top.</li>
      </ol>
      <p className="mm-note">{map.bodies.length} bodies so far. Ctrl+Z undoes, Delete removes, Ctrl+D duplicates, Ctrl+A selects everything.</p>
    </div>
  </div>
);

/** A group selected: the bar along the bottom of the map. */
export const BulkBar: React.FC<{
  map: CustomMap; ids: string[]; theme: string; onChange: Change; onClear: () => void;
}> = ({ map, ids, theme, onChange, onClear }) => {
  const [open, setOpen] = useState<null | 'res' | 'size' | 'name' | 'color' | 'secret'>(null);
  const [mode, setMode] = useState<ResMode>('range');
  const [keep, setKeep] = useState(true);
  const [rows, setRows] = useState<Record<ResKey, { on: boolean; a: number; b: number }>>({
    metal: { on: true, a: 2, b: 8 }, credits: { on: true, a: 2, b: 8 }, science: { on: true, a: 1, b: 6 },
  });
  const [sizeF, setSizeF] = useState(1.25);
  const [nameTheme, setNameTheme] = useState(theme);
  const [color, setColor] = useState('#9a8a78');
  const [vary, setVary] = useState(true);
  const bodies = map.bodies.filter(b => ids.includes(b.id));
  const can = (types: (b: MapBody) => boolean) => bodies.some(types);
  const range = (k: ResKey) => {
    const vs = bodies.filter(b => b.type !== 'rock').map(b => b.yields[k]);
    return vs.length ? `${Math.min(...vs)}–${Math.max(...vs)}` : '–';
  };
  const apply = (next: CustomMap) => { onChange(next, ids); setOpen(null); };

  return (
    <div className="mm-bulk">
      {open === 'res' && (
        <div className="mm-pop" role="dialog" aria-label="Resources for the selection">
          <div className="mm-pop__head">
            <b>Resources for {bodies.length} worlds</b>
            <span className="mm-mono">now: metal {range('metal')} · credits {range('credits')} · science {range('science')}</span>
          </div>
          <div className="mm-seg">
            {([['set', 'Set exactly'], ['add', 'Add / subtract'], ['multiply', 'Multiply'], ['range', 'Random in range']] as Array<[ResMode, string]>).map(([m, l]) => (
              <button key={m} className={`mm-chip${mode === m ? ' is-on' : ''}`} onClick={() => setMode(m)}>{l}</button>
            ))}
          </div>
          {RES.map(r => {
            const row = rows[r.key];
            const setRow = (p: Partial<typeof row>) => setRows({ ...rows, [r.key]: { ...row, ...p } });
            return (
              <div key={r.key} className="mm-res">
                <label className="mm-check is-tight"><input type="checkbox" checked={row.on} onChange={(e) => setRow({ on: e.target.checked })} /><span className={`mm-res__l ${r.cls}`}>{r.label}</span></label>
                <input className="mm-num" type="number" step={mode === 'multiply' ? 0.25 : 1} value={row.a} aria-label={`${r.label} ${mode === 'range' ? 'low' : 'value'}`} onChange={(e) => setRow({ a: Number(e.target.value) })} />
                {mode === 'range' && <><span className="mm-mono">to</span><input className="mm-num" type="number" value={row.b} aria-label={`${r.label} high`} onChange={(e) => setRow({ b: Number(e.target.value) })} /></>}
              </div>
            );
          })}
          {mode === 'range' && (
            <label className="mm-check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /><span>Keep each world's character (rich stays richer than barren)</span></label>
          )}
          <div className="mm-row mm-row--end">
            <button className="mm-btn" onClick={() => setOpen(null)}>Cancel</button>
            <button className="mm-btn is-primary" onClick={() => apply(bulkResources(map, ids, rows, mode, keep))}>Apply to {bodies.length}</button>
          </div>
        </div>
      )}
      {open === 'size' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>Resize {bodies.length}</b><span className="mm-mono">×{sizeF.toFixed(2)}</span></div>
          <Slider label="Size factor" value={sizeF} min={0.5} max={2} step={0.05} onChange={setSizeF} />
          <div className="mm-row mm-row--end"><button className="mm-btn is-primary" onClick={() => apply(scaleSize(map, ids, sizeF))}>Apply</button></div>
        </div>
      )}
      {open === 'name' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>Rename {bodies.length} by theme</b></div>
          <div className="mm-row mm-row--wrap">
            {NAME_THEMES.map(t => <button key={t} className={`mm-chip${nameTheme === t ? ' is-on' : ''}`} onClick={() => setNameTheme(t)}>{t}</button>)}
          </div>
          <div className="mm-row mm-row--end"><button className="mm-btn is-primary" onClick={() => apply(renameByTheme(map, ids, nameTheme))}>Rename</button></div>
        </div>
      )}
      {open === 'color' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>Recolour {bodies.length}</b></div>
          <div className="mm-swatches">
            {SWATCHES.map(c => <button key={c} className={`mm-swatch${color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />)}
            <input type="color" className="mm-swatch is-custom" value={color} aria-label="Pick any colour" onChange={(e) => setColor(e.target.value)} />
          </div>
          <label className="mm-check"><input type="checkbox" checked={vary} onChange={(e) => setVary(e.target.checked)} /><span>Vary each a little</span></label>
          <div className="mm-row mm-row--end"><button className="mm-btn is-primary" onClick={() => apply(recolor(map, ids, color, vary))}>Recolour</button></div>
        </div>
      )}
      {open === 'secret' && (
        <div className="mm-pop">
          <div className="mm-pop__head"><b>Discoveries on {bodies.length} worlds</b><span className="mm-mono">skipped where a kind does not fit</span></div>
          <div className="mm-secret-list is-grid">
            {([null, 'random', ...MAP_SECRETS] as Array<MapSecret | 'random' | null>).map(k => (
              <button key={k ?? 'none'} className="mm-secret" onClick={() => apply(setSecret(map, ids, k))}>
                <span className="mm-secret__n">{k ? secretName(k) : 'Nothing hidden'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mm-bulk__bar">
        <span className="mm-bulk__count">{bodies.length} selected</span>
        <span className="mm-bulk__sep" />
        <button className={`mm-bbtn${open === 'res' ? ' is-on' : ''}`} onClick={() => setOpen(open === 'res' ? null : 'res')}>Resources</button>
        <button className={`mm-bbtn${open === 'size' ? ' is-on' : ''}`} onClick={() => setOpen(open === 'size' ? null : 'size')}>Size</button>
        {can(b => b.parent === 'sun') && <button className="mm-bbtn" onClick={() => apply(spaceEvenly(map, ids))} title="Even spacing between the innermost and outermost selected">Space orbits evenly</button>}
        <button className={`mm-bbtn${open === 'name' ? ' is-on' : ''}`} onClick={() => setOpen(open === 'name' ? null : 'name')}>Rename by theme</button>
        <button className={`mm-bbtn${open === 'color' ? ' is-on' : ''}`} onClick={() => setOpen(open === 'color' ? null : 'color')}>Recolour</button>
        {can(b => canStartOn(b.type)) && (
          bodies.every(b => !canStartOn(b.type) || b.start)
            ? <button className="mm-bbtn" onClick={() => apply(markStart(map, ids, false))}>Unmark start</button>
            : <button className="mm-bbtn" onClick={() => apply(markStart(map, ids, true))}>Mark as start</button>
        )}
        <button className={`mm-bbtn${open === 'secret' ? ' is-on' : ''}`} onClick={() => setOpen(open === 'secret' ? null : 'secret')}>Discoveries</button>
        <button className="mm-bbtn" onClick={() => { const r = duplicateBodies(map, ids, theme); onChange(r.map, r.ids); }}>Duplicate</button>
        <button className="mm-bbtn is-danger" onClick={() => onChange(deleteBodies(map, ids), [])}>Delete</button>
        <button className="mm-bbtn" onClick={onClear} aria-label="Clear selection">✕</button>
      </div>
    </div>
  );
};
