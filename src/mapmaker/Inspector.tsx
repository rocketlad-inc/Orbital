// The Map Maker's side panel: one world (World / Look / Story /
// Secrets), the sun, the whole map when nothing is selected, and -- with
// a group selected -- the bulk bar.

import React, { useState } from 'react';
import {
  type CustomMap, type MapBody, type MapBodyType, type MapSecret, type MapBackdrop, type MapSector,
  TYPE_INFO, SURFACES, MAP_SECRETS, NAME_THEMES, RESOURCE_MAX, SUN_LIMITS, BACKDROPS, TEXT_LIMITS, MAX_BODIES,
  MAX_SECTORS, SECTOR_COLORS,
  canStartOn, secretFits, bodyYear, makeName, startWorlds,
} from '../game/customMap';
import { SECRET_DEFS } from '../game/secrets';
import {
  PRESETS, MOODS, addMoons, changeType, deleteBodies, duplicateBodies, updateBodies, bulkResources,
  spaceEvenly, renameByTheme, recolor, markStart, setSecret, scaleSize, colorForSurface, takenNames,
  mirrorBodies, applyMood, rerollZone, updateSector, deleteSectors, sectorMembers, suggestSectors,
  type ResMode, type ResKey, type MatchAspect,
} from './ops';
import { worldArt } from './planetArt';

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
export const BACKDROP_LABEL: Record<MapBackdrop, string> = {
  deep: 'Deep space', blue: 'Blue nebula', crimson: 'Crimson nebula', emerald: 'Emerald nebula', violet: 'Violet nebula', amber: 'Amber dust',
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

/** − value + : big enough for a thumb, typeable with a keyboard. */
export function Stepper({ value, min, max, step = 1, label, onChange }: {
  value: number; min: number; max: number; step?: number; label: string; onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v / step) * step)));
  return (
    <span className="mm-step">
      <button type="button" className="mm-step__b" aria-label={`Less ${label}`} onClick={() => set(value - step)} disabled={value <= min}>−</button>
      <input className="mm-step__v" type="number" inputMode="numeric" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => set(Number(e.target.value))} />
      <button type="button" className="mm-step__b" aria-label={`More ${label}`} onClick={() => set(value + step)} disabled={value >= max}>+</button>
    </span>
  );
}

/** A world's face as the game paints it. */
export function WorldFace({ body, size = 48 }: { body: Pick<MapBody, 'id' | 'type' | 'color' | 'surface' | 'rings'>; size?: number }) {
  const art = body.type === 'rock' ? null : worldArt(body, 128);
  return (
    <span className={`mm-face${body.rings ? ' has-rings' : ''}`} style={{ width: size, height: size }} aria-hidden>
      {art
        ? <img src={art} alt="" />
        : <span className="mm-face__flat" style={{ background: `radial-gradient(circle at 35% 32%, #fff8, ${body.color} 55%, #0008)` }} />}
    </span>
  );
}

/** One world. */
export const BodyInspector: React.FC<{
  map: CustomMap; body: MapBody; theme: string; onChange: Change; onTransient: (m: CustomMap) => void;
}> = ({ map, body, theme, onChange, onTransient }) => {
  const [tab, setTab] = useState<'world' | 'look' | 'story' | 'secrets'>('world');
  const info = TYPE_INFO[body.type];
  const patch = (p: Partial<MapBody>) => onChange(updateBodies(map, [body.id], () => p));
  const live = (p: Partial<MapBody>) => onTransient(updateBodies(map, [body.id], () => p));
  // Text mid-typing skips the cleaner, which trims: a trailing space
  // would vanish under the cursor. It is cleaned on blur.
  const liveText = (p: Partial<MapBody>) => onTransient({ ...map, bodies: map.bodies.map(x => (x.id === body.id ? { ...x, ...p } : x)) });
  const moons = map.bodies.filter(b => b.parent === body.id);
  const parent = body.parent === 'sun' ? null : map.bodies.find(b => b.id === body.parent);
  const year = Math.round(bodyYear(map, body));
  const st = startWorlds(map);
  const typeChoices: MapBodyType[] = body.type === 'moon' ? ['moon', ...TYPES_FOR_SUN] : TYPES_FOR_SUN;
  const fixedSecret = !!body.secret && body.secret !== 'random';

  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <WorldFace body={body} size={52} />
        <div className="mm-insp__id">
          <input
            className="mm-insp__name" value={body.name} aria-label="World name" maxLength={24}
            onChange={(e) => liveText({ name: e.target.value })}
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
        {(['world', 'look', 'story', 'secrets'] as const).map(t => (
          <button key={t} role="tab" aria-selected={tab === t} className={`mm-chip${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {t === 'world' ? 'World' : t === 'look' ? 'Look' : t === 'story' ? 'Story' : 'Secrets'}
            {t === 'story' && body.lore ? ' ·' : ''}
            {t === 'secrets' && body.secret ? ' ?' : ''}
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
                  <Stepper label={`${r.label} per tick`} value={body.yields[r.key]} min={0} max={RESOURCE_MAX}
                    onChange={(v) => patch({ yields: { ...body.yields, [r.key]: v } })} />
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
              <input className="mm-input" type="number" inputMode="numeric" value={Math.round(body.orbit)} min={1}
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
                <button className="mm-chip is-dashed" onClick={() => { const r = addMoons(map, body.id, 1, theme); onChange(r.map, [body.id]); }}>+ Moon</button>
                <button className="mm-chip is-dashed" onClick={() => { const r = addMoons(map, body.id, 3, theme); onChange(r.map, [body.id]); }}>+ 3 moons</button>
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
          <div className="mm-look">
            <WorldFace body={body} size={132} />
            <p className="mm-note">This is the face the game paints on {body.name}. Players see this exact world.</p>
          </div>
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

      {tab === 'story' && (
        <div className="mm-insp__body">
          <div className="mm-sec mm-sec--row"><span>A LINE OF LORE</span><span className="mm-mono">{(body.lore ?? '').length}/{TEXT_LIMITS.lore}</span></div>
          <textarea
            className="mm-input mm-text" rows={4} maxLength={TEXT_LIMITS.lore}
            placeholder={`What is ${body.name}? A cradle, a graveyard, a rumour…`}
            value={body.lore ?? ''} aria-label="World lore"
            onChange={(e) => liveText({ lore: e.target.value })} onBlur={(e) => patch({ lore: e.target.value })}
          />
          <p className="mm-note">Players read it when they open this world in the game.</p>
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
              {fixedSecret && (
                <div className="mm-box">
                  <div className="mm-sec">TELL IT YOUR WAY (OPTIONAL)</div>
                  <Field label="ITS NAME">
                    <input className="mm-input" maxLength={TEXT_LIMITS.secretName} placeholder={secretName(body.secret!)}
                      value={body.secretName ?? ''} onChange={(e) => liveText({ secretName: e.target.value })} onBlur={(e) => patch({ secretName: e.target.value })} />
                  </Field>
                  <Field label={`WHAT THE FINDER READS · ${(body.secretText ?? '').length}/${TEXT_LIMITS.secretText}`}>
                    <textarea className="mm-input mm-text" rows={3} maxLength={TEXT_LIMITS.secretText}
                      placeholder="The hatch opens on a hall of sleeping engines…"
                      value={body.secretText ?? ''} onChange={(e) => liveText({ secretText: e.target.value })} onBlur={(e) => patch({ secretText: e.target.value })} />
                  </Field>
                  <p className="mm-note">The reward is still the {secretName(body.secret!)}; only the words change. Nobody sees them before it is found.</p>
                </div>
              )}
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

/** Nothing selected: the whole map -- its pitch, its sky, its mood. */
export const MapInspector: React.FC<{
  map: CustomMap; theme: string; touch: boolean; onChange: Change; onTransient: (m: CustomMap) => void;
  onDrawSector: () => void; onPickSector: (id: string) => void;
}> = ({ map, theme, touch, onChange, onTransient, onDrawSector, onPickSector }) => {
  const [confirm, setConfirm] = useState<'inner' | 'outer' | null>(null);
  const reroll = (zone: 'inner' | 'outer') => { const r = rerollZone(map, zone, theme); onChange(r.map, r.ids); setConfirm(null); };
  const tap = touch ? 'Tap' : 'Click';
  return (
    <div className="mm-insp">
      <div className="mm-insp__body">
        {map.bodies.length < 3 && (
          <>
            <div className="mm-sec">GETTING STARTED</div>
            <ol className="mm-steps">
              <li>{touch ? 'Tap + and pick a world, then tap the map.' : 'Pick something on the left, then click the map to place it.'}</li>
              <li>{tap} a world to name it, shape it and set what it yields.</li>
              <li>{touch ? 'Long-press worlds to gather a group, then change them all at once.' : 'Drag a world to move it. Drag empty space to select a group.'}</li>
              <li>Mark where players start, hide a few discoveries, and check the list at the top.</li>
            </ol>
          </>
        )}
        <div className="mm-sec mm-sec--row"><span>THE PITCH</span><span className="mm-mono">{map.blurb.length}/{TEXT_LIMITS.blurb}</span></div>
        <textarea className="mm-input mm-text" rows={3} maxLength={TEXT_LIMITS.blurb}
          placeholder="Two empires, one dying star, and a moon nobody should land on…"
          value={map.blurb} aria-label="Map pitch"
          onChange={(e) => onTransient({ ...map, blurb: e.target.value })} onBlur={(e) => onChange({ ...map, blurb: e.target.value })} />
        <p className="mm-note">Shown in the gallery and on the lobby of every game on this map.</p>

        <div className="mm-sec">MOOD · RESTYLE EVERYTHING</div>
        <div className="mm-moods">
          {MOODS.map(m => (
            <button key={m.id} className={`mm-mood is-${m.backdrop}`} onClick={() => onChange(applyMood(map, m))} title={m.blurb}>
              <span className="mm-mood__sun" style={{ background: m.sun }} />
              <b>{m.label}</b>
            </button>
          ))}
        </div>

        <div className="mm-sec">THE SKY BEHIND</div>
        <div className="mm-row mm-row--wrap">
          {BACKDROPS.map(bd => (
            <button key={bd} className={`mm-chip is-small mm-bd is-${bd}${map.settings.backdrop === bd ? ' is-on' : ''}`}
              onClick={() => onChange({ ...map, settings: { ...map.settings, backdrop: bd } })}>
              {BACKDROP_LABEL[bd]}
            </button>
          ))}
        </div>

        <div className="mm-sec mm-sec--row"><span>SECTORS</span><span className="mm-mono">{map.sectors.length}/{MAX_SECTORS}</span></div>
        {map.sectors.length === 0 ? (
          <p className="mm-note">Sectors are the regions players fight over: the senate gives one vote for each sector you hold most of. Draw bands of orbit, or let the map suggest some. Without them, worlds group automatically (a planet with its moons).</p>
        ) : (
          <div className="mm-sectors">
            {map.sectors.map(sct => (
              <button key={sct.id} className="mm-sectorrow" onClick={() => onPickSector(sct.id)}>
                <span className="mm-dot" style={{ background: sct.color }} />
                <span className="mm-sectorrow__n">{sct.name}</span>
                <span className="mm-mono">{sectorMembers(map, sct.id).filter(b => b.type !== 'rock').length} worlds</span>
              </button>
            ))}
          </div>
        )}
        <div className="mm-row mm-row--wrap">
          <button className="mm-btn" disabled={map.sectors.length >= MAX_SECTORS} onClick={onDrawSector}>Draw a sector</button>
          <button className="mm-btn" disabled={map.bodies.length < 2} onClick={() => onChange(suggestSectors(map, Math.max(3, Math.min(6, map.sectors.length || 4))))}>
            {map.sectors.length ? 'Re-suggest' : 'Suggest sectors'}
          </button>
          {map.sectors.length > 0 && <button className="mm-btn is-danger" onClick={() => onChange(deleteSectors(map, map.sectors.map(x => x.id)))}>Clear all</button>}
        </div>

        <div className="mm-sec">RE-ROLL HALF THE SYSTEM</div>
        {confirm ? (
          <div className="mm-box">
            <p className="mm-note">Replace every {confirm} world, its moons and belts with new ones? Undo brings them back.</p>
            <div className="mm-row mm-row--end">
              <button className="mm-btn" onClick={() => setConfirm(null)}>Keep them</button>
              <button className="mm-btn is-primary" onClick={() => reroll(confirm)}>Re-roll the {confirm} system</button>
            </div>
          </div>
        ) : (
          <div className="mm-row">
            <button className="mm-btn" disabled={map.bodies.length < 2} onClick={() => setConfirm('inner')}>Inner worlds</button>
            <button className="mm-btn" disabled={map.bodies.length < 2} onClick={() => setConfirm('outer')}>Outer worlds</button>
          </div>
        )}
        {!touch && <p className="mm-note">{map.bodies.length} bodies. Ctrl+Z undoes, Delete removes, Ctrl+D duplicates, Ctrl+A selects everything.</p>}
      </div>
    </div>
  );
};

/** One sector: its name, colour, edges and the worlds inside. */
export const SectorInspector: React.FC<{
  map: CustomMap; sector: MapSector; onChange: Change; onTransient: (m: CustomMap) => void;
  onSelectWorlds: (ids: string[]) => void;
}> = ({ map, sector, onChange, onTransient, onSelectWorlds }) => {
  const set = (p: Partial<MapSector>) => onChange(updateSector(map, sector.id, p), [`sector:${sector.id}`]);
  const members = sectorMembers(map, sector.id);
  const worlds = members.filter(b => b.type !== 'rock');
  const starts = members.filter(b => b.start);
  const i = map.sectors.findIndex(x => x.id === sector.id);
  const inside = map.sectors[i - 1], outside = map.sectors[i + 1];
  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <span className="mm-sectorbadge" style={{ borderColor: sector.color }} aria-hidden><span style={{ background: sector.color }} /></span>
        <div className="mm-insp__id">
          <input className="mm-insp__name" value={sector.name} aria-label="Sector name" maxLength={24}
            onChange={(e) => onTransient(updateSector(map, sector.id, { name: e.target.value }, false))}
            onBlur={(e) => set({ name: e.target.value })} />
          <span className="mm-insp__sub">Sector · orbits {sector.inner} to {sector.outer}</span>
        </div>
      </div>
      <div className="mm-insp__body">
        <div className="mm-sec">COLOUR</div>
        <div className="mm-swatches">
          {SECTOR_COLORS.map(c => <button key={c} className={`mm-swatch${sector.color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => set({ color: c })} />)}
          <input type="color" className="mm-swatch is-custom" value={sector.color} aria-label="Pick any colour"
            onChange={(e) => onTransient(updateSector(map, sector.id, { color: e.target.value }, false))} onBlur={(e) => set({ color: e.target.value })} />
        </div>
        <div className="mm-grid2">
          <Field label="INNER EDGE">
            <Stepper label="Inner edge" value={sector.inner} min={inside ? inside.outer : 0} max={sector.outer - 10} step={10} onChange={(v) => set({ inner: v })} />
          </Field>
          <Field label="OUTER EDGE">
            <Stepper label="Outer edge" value={sector.outer} min={sector.inner + 10} max={outside ? outside.inner : 15400} step={10} onChange={(v) => set({ outer: v })} />
          </Field>
        </div>
        <p className="mm-note">Drag either edge on the map to move it. Where two sectors touch, the shared edge moves both; bands never overlap.</p>
        <div className="mm-box">
          <b className="mm-sectorstat">{worlds.length} world{worlds.length === 1 ? '' : 's'}{starts.length ? ` · ${starts.length} start${starts.length === 1 ? '' : 's'}` : ''}</b>
          <div className="mm-row mm-row--wrap">
            {worlds.slice(0, 18).map(b => <span key={b.id} className="mm-pill">{b.name}</span>)}
            {worlds.length > 18 && <span className="mm-mono">+{worlds.length - 18}</span>}
          </div>
          <p className="mm-note">Whoever holds the most of these worlds controls {sector.name}: one more vote in the senate. A tie leaves it contested and worth nothing.</p>
        </div>
        <div className="mm-row mm-row--end">
          <button className="mm-btn" disabled={!worlds.length} onClick={() => onSelectWorlds(worlds.map(b => b.id))}>Select its worlds</button>
          <button className="mm-btn is-danger" onClick={() => onChange(deleteSectors(map, [sector.id]), [])}>Delete sector</button>
        </div>
      </div>
    </div>
  );
};

/** A group selected: the bar along the bottom of the map (or, on a
 *  phone, the action grid in the sheet). */
export const BulkBar: React.FC<{
  map: CustomMap; ids: string[]; theme: string; compact?: boolean;
  onChange: Change; onClear: () => void;
  onMatch: (aspects: Set<MatchAspect>) => void;
}> = ({ map, ids, theme, compact, onChange, onClear, onMatch }) => {
  const [open, setOpen] = useState<null | 'res' | 'size' | 'name' | 'color' | 'secret' | 'mirror' | 'match' | 'mood'>(null);
  const [mode, setMode] = useState<ResMode>('range');
  const [keep, setKeep] = useState(true);
  const [rows, setRows] = useState<Record<ResKey, { on: boolean; a: number; b: number }>>({
    metal: { on: true, a: 2, b: 8 }, credits: { on: true, a: 2, b: 8 }, science: { on: true, a: 1, b: 6 },
  });
  const [sizeF, setSizeF] = useState(1.25);
  const [nameTheme, setNameTheme] = useState(theme);
  const [color, setColor] = useState('#9a8a78');
  const [vary, setVary] = useState(true);
  const [ways, setWays] = useState(4);
  const [aspects, setAspects] = useState<Set<MatchAspect>>(new Set(['resources', 'look']));
  const bodies = map.bodies.filter(b => ids.includes(b.id));
  const can = (types: (b: MapBody) => boolean) => bodies.some(types);
  const range = (k: ResKey) => {
    const vs = bodies.filter(b => b.type !== 'rock').map(b => b.yields[k]);
    return vs.length ? `${Math.min(...vs)}–${Math.max(...vs)}` : '–';
  };
  const apply = (next: CustomMap, select: string[] = ids) => { onChange(next, select); setOpen(null); };
  const toggle = (k: typeof open) => setOpen(open === k ? null : k);
  const roots = bodies.filter(b => b.parent === 'sun').length;
  const rootIds = new Set(bodies.map(b => (b.parent === 'sun' ? b.id : b.parent)));
  const mirrorCost = map.bodies.filter(b => rootIds.has(b.id) || rootIds.has(b.parent)).length;

  return (
    <div className={`mm-bulk${compact ? ' is-compact' : ''}`}>
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
                <input className="mm-num" type="number" inputMode="decimal" step={mode === 'multiply' ? 0.25 : 1} value={row.a} aria-label={`${r.label} ${mode === 'range' ? 'low' : 'value'}`} onChange={(e) => setRow({ a: Number(e.target.value) })} />
                {mode === 'range' && <><span className="mm-mono">to</span><input className="mm-num" type="number" inputMode="numeric" value={row.b} aria-label={`${r.label} high`} onChange={(e) => setRow({ b: Number(e.target.value) })} /></>}
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
      {open === 'mood' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>Restyle {bodies.length}</b><span className="mm-mono">surfaces and colours</span></div>
          <div className="mm-moods">
            {MOODS.map(m => (
              <button key={m.id} className={`mm-mood is-${m.backdrop}`} onClick={() => apply(applyMood(map, m, ids))} title={m.blurb}>
                <span className="mm-mood__sun" style={{ background: m.sun }} /><b>{m.label}</b>
              </button>
            ))}
          </div>
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
      {open === 'mirror' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>Mirror round the sun</b><span className="mm-mono">{roots} world{roots === 1 ? '' : 's'} × {ways}</span></div>
          <div className="mm-seg">
            {[2, 3, 4, 5, 6, 8].map(n => <button key={n} className={`mm-chip${ways === n ? ' is-on' : ''}`} onClick={() => setWays(n)}>{n} ways</button>)}
          </div>
          <p className="mm-note">Copies each selected world (with its moons, start mark and discovery) {ways - 1} more time{ways > 2 ? 's' : ''}, evenly round the sun: every player gets the same neighbourhood.</p>
          {map.bodies.length + mirrorCost * (ways - 1) > MAX_BODIES && (
            <p className="mm-note is-bad">That is {mirrorCost * (ways - 1)} new bodies and a map holds {MAX_BODIES}: only {Math.max(0, MAX_BODIES - map.bodies.length)} would fit. Mirror fewer worlds, or fewer ways.</p>
          )}
          <div className="mm-row mm-row--end">
            <button className="mm-btn is-primary" onClick={() => { const r = mirrorBodies(map, ids, ways, theme); apply(r.map, r.ids); }}>Mirror {ways} ways</button>
          </div>
        </div>
      )}
      {open === 'match' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>Make them match a world</b></div>
          <div className="mm-row mm-row--wrap">
            {([['resources', 'Resources'], ['look', 'Look'], ['size', 'Size'], ['secret', 'Discovery']] as Array<[MatchAspect, string]>).map(([k, l]) => (
              <label key={k} className="mm-check is-tight">
                <input type="checkbox" checked={aspects.has(k)} onChange={(e) => { const n = new Set(aspects); if (e.target.checked) n.add(k); else n.delete(k); setAspects(n); }} />
                <span>{l}</span>
              </label>
            ))}
          </div>
          <div className="mm-row mm-row--end">
            <button className="mm-btn is-primary" disabled={!aspects.size} onClick={() => { onMatch(aspects); setOpen(null); }}>Pick the world to copy</button>
          </div>
        </div>
      )}

      <div className="mm-bulk__bar">
        <span className="mm-bulk__count">{bodies.length} selected</span>
        {!compact && <span className="mm-bulk__sep" />}
        <button className={`mm-bbtn${open === 'res' ? ' is-on' : ''}`} onClick={() => toggle('res')}>Resources</button>
        <button className={`mm-bbtn${open === 'match' ? ' is-on' : ''}`} onClick={() => toggle('match')}>Match a world</button>
        {roots > 0 && <button className={`mm-bbtn${open === 'mirror' ? ' is-on' : ''}`} onClick={() => toggle('mirror')}>Mirror</button>}
        <button className={`mm-bbtn${open === 'size' ? ' is-on' : ''}`} onClick={() => toggle('size')}>Size</button>
        {can(b => b.parent === 'sun') && <button className="mm-bbtn" onClick={() => apply(spaceEvenly(map, ids))} title="Even spacing between the innermost and outermost selected">Space evenly</button>}
        <button className={`mm-bbtn${open === 'name' ? ' is-on' : ''}`} onClick={() => toggle('name')}>Rename</button>
        <button className={`mm-bbtn${open === 'color' ? ' is-on' : ''}`} onClick={() => toggle('color')}>Recolour</button>
        <button className={`mm-bbtn${open === 'mood' ? ' is-on' : ''}`} onClick={() => toggle('mood')}>Mood</button>
        {can(b => canStartOn(b.type)) && (
          bodies.every(b => !canStartOn(b.type) || b.start)
            ? <button className="mm-bbtn" onClick={() => apply(markStart(map, ids, false))}>Unmark start</button>
            : <button className="mm-bbtn" onClick={() => apply(markStart(map, ids, true))}>Mark as start</button>
        )}
        <button className={`mm-bbtn${open === 'secret' ? ' is-on' : ''}`} onClick={() => toggle('secret')}>Discoveries</button>
        <button className="mm-bbtn" onClick={() => { const r = duplicateBodies(map, ids, theme); onChange(r.map, r.ids); }}>Duplicate</button>
        <button className="mm-bbtn is-danger" onClick={() => onChange(deleteBodies(map, ids), [])}>Delete</button>
        <button className="mm-bbtn" onClick={onClear} aria-label="Clear selection">✕</button>
      </div>
    </div>
  );
};
