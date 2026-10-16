// The Map Maker's side panel: one world (World / Look / Story /
// Secrets), the sun, the whole map when nothing is selected, and -- with
// a group selected -- the bulk bar.

import React, { useId, useRef, useState } from 'react';
import {
  type CustomMap, type MapBody, type MapBodyType, type MapSecret, type MapSector,
  TYPE_INFO, SURFACES, MAP_SECRETS, NAME_THEMES, RESOURCE_MAX, SUN_LIMITS, BACKDROPS, TEXT_LIMITS, MAX_BODIES,
  MAX_SECTORS, SECTOR_COLORS, ORBIT_LIMITS,
  canStartOn, secretFits, bodyYear, makeName, startWorlds,
} from '../game/customMap';
import { t, tn, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import {
  PRESETS, MOODS, MOONLESS_TYPES, addMoons, changeType, deleteBodies, duplicateBodies, updateBodies, bulkResources,
  spaceEvenly, renameByTheme, recolor, markStart, setSecret, scaleSize, colorForSurface, takenNames,
  mirrorBodies, applyMood, rerollZone, updateSector, deleteSectors, sectorMembers, suggestSectors,
  type ResMode, type ResKey, type MatchAspect,
} from './ops';
import { worldArt, useArtTick } from './planetArt';
import {
  typeLabel, surfaceLabel, backdropLabel, themeLabel, presetLabel, moodLabel, moodBlurb, starLabel,
  secretName, secretHint, touchKey,
} from './mmText';

type Change = (next: CustomMap, select?: string[]) => void;

/** Resource rows; labels are the game's own (econ.res.*), read at render. */
const RES: Array<{ key: ResKey; labelKey: Key; cls: string }> = [
  { key: 'metal', labelKey: 'econ.res.metal', cls: 'is-metal' },
  { key: 'credits', labelKey: 'econ.res.credits', cls: 'is-credits' },
  { key: 'science', labelKey: 'econ.res.science', cls: 'is-science' },
];
const SWATCHES = ['#4f8a3c', '#2f8fd6', '#c9a36b', '#9a8a78', '#a0a6ad', '#cfe8f2', '#d65a2a', '#9ab83c', '#d4a574', '#73c2d6', '#c1440e', '#8a6bbf'];
const STAR_SWATCHES = [
  { c: '#ffd180', label: 'Yellow sun' }, { c: '#fff1d6', label: 'White sun' },
  { c: '#ff9b5e', label: 'Orange sun' }, { c: '#a9c8ff', label: 'Blue giant' },
];
const TYPES_FOR_SUN: MapBodyType[] = ['terrestrial', 'gas-giant', 'ice-giant', 'dwarf', 'asteroid', 'rock'];
const BULK_MODES: ResMode[] = ['set', 'add', 'multiply', 'range'];
const MATCH_ASPECTS: MatchAspect[] = ['resources', 'look', 'size', 'secret'];
const k = (key: string) => key as Key;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mm-field"><span className="mm-field__l">{label}</span>{children}</label>;
}

/** A caption over a control that is not one input (a stepper): a
 *  <label> round it would forward a tap on the caption to its first
 *  button, the "−". */
export function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className="mm-field" role="group" aria-labelledby={id}>
      <span className="mm-field__l" id={id}>{label}</span>{children}
    </div>
  );
}

/** What a name field puts back when it is cleared: the name it had when
 *  it took focus (the cleaner's fallback would be English). */
function useNameGuard(current: string) {
  const before = useRef(current);
  return {
    onFocus: () => { before.current = current; },
    keep: (typed: string) => (typed.trim() ? typed : before.current),
  };
}

const clampTo = (v: number, min: number, max: number, step?: number) => {
  let c = Math.min(max, Math.max(min, v));
  if (step) c = Math.min(max, Math.max(min, Math.round(c / step) * step));
  // Float steps (0.25) land exactly, not on 0.7500000001.
  return Math.round(c * 1e6) / 1e6;
};

/**
 * A typed number that does not fight the typist: it edits as text and
 * only commits (clamped) on blur or Enter. Escape, or anything that is
 * not a number, puts the last good value back. One commit, one undo step.
 */
export function NumberField({ value, min, max, step, label, className = 'mm-input', decimal, onCommit }: {
  value: number; min: number; max: number; step?: number; label?: string; className?: string; decimal?: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const show = (v: number) => String(Math.round(v * 1e6) / 1e6);
  const commit = () => {
    if (text == null) return;
    setText(null);
    const v = Number(text.trim().replace(',', '.'));
    if (!text.trim() || !Number.isFinite(v)) return;
    const c = clampTo(v, min, max, step);
    if (c !== value) onCommit(c);
  };
  return (
    <input
      className={className} type="text" inputMode={decimal ? 'decimal' : 'numeric'} aria-label={label}
      value={text ?? show(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(null); }
      }}
    />
  );
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
  useI18n();
  const set = (v: number) => { const c = clampTo(v, min, max, step); if (c !== value) onChange(c); };
  return (
    <span className="mm-step">
      <button type="button" className="mm-step__b" aria-label={t('mm.step.less', { label })} onClick={() => set(value - step)} disabled={value <= min}>−</button>
      <NumberField className="mm-step__v" value={value} min={min} max={max} step={step} label={label} onCommit={set} />
      <button type="button" className="mm-step__b" aria-label={t('mm.step.more', { label })} onClick={() => set(value + step)} disabled={value >= max}>+</button>
    </span>
  );
}

/** A world's face as the game paints it. */
export function WorldFace({ body, size = 48 }: { body: Pick<MapBody, 'id' | 'type' | 'color' | 'surface' | 'rings'>; size?: number }) {
  useArtTick();
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
  useI18n();
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
  const nameGuard = useNameGuard(body.name);
  const orbitLim = body.parent === 'sun' ? ORBIT_LIMITS.sun : ORBIT_LIMITS.moon;

  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <WorldFace body={body} size={52} />
        <div className="mm-insp__id">
          <input
            className="mm-insp__name" value={body.name} aria-label={t('mm.world.nameAria')} maxLength={24}
            onFocus={nameGuard.onFocus}
            onChange={(e) => liveText({ name: e.target.value })}
            onBlur={(e) => patch({ name: nameGuard.keep(e.target.value) })}
          />
          <span className="mm-insp__sub">
            {parent
              ? t('mm.world.moonOf', { type: typeLabel(body.type), name: parent.name })
              : t('mm.world.orbits', { type: typeLabel(body.type), name: map.sun.name })}
          </span>
        </div>
        <button
          className="mm-icon" aria-label={t('mm.world.randomName')} title={t('mm.world.randomName')}
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
        {(['world', 'look', 'story', 'secrets'] as const).map(tb => (
          <button key={tb} role="tab" aria-selected={tab === tb} className={`mm-chip${tab === tb ? ' is-on' : ''}`} onClick={() => setTab(tb)}>
            {t(`mm.tab.${tb}`)}
            {tb === 'story' && body.lore ? ' ·' : ''}
            {tb === 'secrets' && body.secret ? ' ?' : ''}
          </button>
        ))}
      </div>

      {tab === 'world' && (
        <div className="mm-insp__body">
          {body.type === 'rock' ? (
            <>
              <div className="mm-sec">{t('mm.rock.ore')}</div>
              <div className="mm-row">
                {(['metal', 'gold'] as const).map(kd => (
                  <button key={kd} className={`mm-chip${body.mineral?.kind === kd ? ' is-on' : ''}`} onClick={() => patch({ mineral: { kind: kd, tons: body.mineral?.tons ?? 1200 } })}>
                    {kd === 'metal' ? t('mm.rock.metal') : t('mm.rock.gold')}
                  </button>
                ))}
              </div>
              <Field label={t('mm.rock.tonnage', { n: body.mineral?.tons ?? 0 })}>
                <Slider label={t('mm.rock.tonnageAria')} value={body.mineral?.tons ?? 1200} min={200} max={5000} step={25}
                  onChange={(v) => live({ mineral: { kind: body.mineral?.kind ?? 'metal', tons: v } })}
                  onCommit={() => onChange(map)} />
              </Field>
              <p className="mm-note">{t('mm.rock.note')}</p>
            </>
          ) : (
            <>
              <div className="mm-sec mm-sec--row"><span>{t('mm.world.resources')}</span></div>
              {RES.map(r => (
                <div key={r.key} className="mm-res">
                  <span className={`mm-res__l ${r.cls}`}>{t(r.labelKey)}</span>
                  <Slider label={t(r.labelKey)} value={body.yields[r.key]} min={0} max={RESOURCE_MAX}
                    onChange={(v) => live({ yields: { ...body.yields, [r.key]: v } })}
                    onCommit={() => onChange(map)} />
                  <Stepper label={t('mm.world.perTick', { res: t(r.labelKey) })} value={body.yields[r.key]} min={0} max={RESOURCE_MAX}
                    onChange={(v) => patch({ yields: { ...body.yields, [r.key]: v } })} />
                </div>
              ))}
              <div className="mm-row mm-row--wrap">
                {PRESETS.map(p => (
                  <button key={p.label} className="mm-chip is-small" onClick={() => patch({ yields: { ...p.y } })}>{presetLabel(p.label)}</button>
                ))}
              </div>
            </>
          )}

          <div className="mm-grid2">
            <Field label={t('mm.world.orbit')}>
              <NumberField value={Math.round(body.orbit)} min={orbitLim[0]} max={orbitLim[1]} step={1}
                onCommit={(v) => patch({ orbit: v })} />
            </Field>
            <Field label={t('mm.world.year')}>
              <input className="mm-input is-ro" readOnly value={tn('mm.n.ticks', year)} />
            </Field>
            <Field label={t('mm.sizeVal', { n: body.radius.toFixed(1) })}>
              <Slider label={t('mm.world.size')} value={body.radius} min={info.radius[0]} max={info.radius[1]} step={0.1}
                onChange={(v) => live({ radius: v })} onCommit={() => onChange(map)} />
            </Field>
            <Field label={t('mm.world.type')}>
              <select className="mm-input" value={body.type} onChange={(e) => onChange(changeType(map, body.id, e.target.value as MapBodyType))}>
                {typeChoices.map(ty => (
                  <option key={ty} value={ty} disabled={moons.length > 0 && MOONLESS_TYPES.has(ty) && ty !== body.type}>{typeLabel(ty)}</option>
                ))}
              </select>
            </Field>
          </div>
          {moons.length > 0 && <p className="mm-note">{t('mm.world.typeMoonsNote')}</p>}

          {canStartOn(body.type) && (
            <div className="mm-box">
              <label className="mm-check">
                <input type="checkbox" checked={!!body.start} onChange={(e) => patch({ start: e.target.checked })} />
                <span>{t('mm.world.canStart')}</span>
                {body.start && <span className="mm-tag is-start">{t('mm.world.startTag')}</span>}
              </label>
              <p className="mm-note">
                {st.marked
                  ? tn('mm.world.startsMarked', st.worlds.length, { seats: Math.min(10, st.worlds.length) })
                  : t('mm.world.startsAuto')}
              </p>
            </div>
          )}

          {body.parent === 'sun' && body.type !== 'asteroid' && body.type !== 'rock' && (
            <div>
              <div className="mm-sec">{t('mm.world.moons')}</div>
              <div className="mm-row mm-row--wrap">
                {moons.map(m => <span key={m.id} className="mm-pill">{m.name}</span>)}
                <button className="mm-chip is-dashed" onClick={() => { const r = addMoons(map, body.id, 1, theme); onChange(r.map, [body.id]); }}>{t('mm.world.addMoon')}</button>
                <button className="mm-chip is-dashed" onClick={() => { const r = addMoons(map, body.id, 3, theme); onChange(r.map, [body.id]); }}>{t('mm.world.add3Moons')}</button>
              </div>
            </div>
          )}

          <div className="mm-row mm-row--end">
            <button className="mm-btn" onClick={() => { const r = duplicateBodies(map, [body.id], theme); onChange(r.map, r.ids); }}>{t('mm.duplicate')}</button>
            <button className="mm-btn is-danger" onClick={() => onChange(deleteBodies(map, [body.id]), [])}>{t('mm.delete')}</button>
          </div>
        </div>
      )}

      {tab === 'look' && (
        <div className="mm-insp__body">
          <div className="mm-look">
            <WorldFace body={body} size={132} />
            <p className="mm-note">{t('mm.look.note', { name: body.name })}</p>
          </div>
          <div className="mm-sec">{t('mm.colour')}</div>
          <div className="mm-swatches">
            {SWATCHES.map(c => (
              <button key={c} className={`mm-swatch${body.color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={t('mm.colourOf', { c })} onClick={() => patch({ color: c })} />
            ))}
            <input type="color" className="mm-swatch is-custom" value={body.color} aria-label={t('mm.anyColour')} onChange={(e) => live({ color: e.target.value })} onBlur={() => onChange(map)} />
          </div>
          {body.type !== 'rock' && (
            <>
              <div className="mm-sec">{t('mm.look.surface')}</div>
              <div className="mm-row mm-row--wrap">
                {SURFACES.map(s => (
                  <button key={s} className={`mm-chip is-small${body.surface === s ? ' is-on' : ''}`}
                    onClick={() => patch({ surface: s, color: colorForSurface(s, body.color) })}>
                    {surfaceLabel(s)}
                  </button>
                ))}
              </div>
              <p className="mm-note">{t('mm.look.surfaceNote')}</p>
            </>
          )}
          {(body.type === 'gas-giant' || body.type === 'ice-giant' || body.type === 'terrestrial') && (
            <label className="mm-check">
              <input type="checkbox" checked={!!body.rings} onChange={(e) => patch({ rings: e.target.checked })} />
              <span>{t('mm.look.rings')}</span>
            </label>
          )}
        </div>
      )}

      {tab === 'story' && (
        <div className="mm-insp__body">
          <div className="mm-sec mm-sec--row"><span>{t('mm.story.title')}</span><span className="mm-mono">{(body.lore ?? '').length}/{TEXT_LIMITS.lore}</span></div>
          <textarea
            className="mm-input mm-text" rows={4} maxLength={TEXT_LIMITS.lore}
            placeholder={t('mm.story.placeholder', { name: body.name })}
            value={body.lore ?? ''} aria-label={t('mm.story.aria')}
            onChange={(e) => liveText({ lore: e.target.value })} onBlur={(e) => patch({ lore: e.target.value })}
          />
          <p className="mm-note">{t('mm.story.note')}</p>
        </div>
      )}

      {tab === 'secrets' && (
        <div className="mm-insp__body">
          {body.type === 'rock' ? (
            <p className="mm-note">{t('mm.secrets.rock')}</p>
          ) : (
            <>
              <div className="mm-sec">{t('mm.secrets.title')}</div>
              <p className="mm-note">{t('mm.secrets.note')}</p>
              <div className="mm-secret-list">
                {([null, 'random', ...MAP_SECRETS] as Array<MapSecret | 'random' | null>).map(kd => {
                  const fits = secretFits(kd, body.type);
                  const on = (body.secret ?? null) === kd;
                  return (
                    <button
                      key={kd ?? 'none'} disabled={!fits || (!!body.start && !!kd)}
                      className={`mm-secret${on ? ' is-on' : ''}`}
                      onClick={() => patch({ secret: kd })}
                    >
                      <span className="mm-secret__n">{kd ? secretName(kd) : t('mm.secret.none')}</span>
                      {kd && <span className="mm-secret__d">{secretHint(kd)}</span>}
                    </button>
                  );
                })}
              </div>
              {fixedSecret && (
                <div className="mm-box">
                  <div className="mm-sec">{t('mm.secrets.yourWay')}</div>
                  <Field label={t('mm.secrets.itsName')}>
                    <input className="mm-input" maxLength={TEXT_LIMITS.secretName} placeholder={secretName(body.secret!)}
                      value={body.secretName ?? ''} onChange={(e) => liveText({ secretName: e.target.value })} onBlur={(e) => patch({ secretName: e.target.value })} />
                  </Field>
                  <Field label={t('mm.secrets.finderReads', { n: (body.secretText ?? '').length, max: TEXT_LIMITS.secretText })}>
                    <textarea className="mm-input mm-text" rows={3} maxLength={TEXT_LIMITS.secretText}
                      placeholder={t('mm.secrets.textPlaceholder')}
                      value={body.secretText ?? ''} onChange={(e) => liveText({ secretText: e.target.value })} onBlur={(e) => patch({ secretText: e.target.value })} />
                  </Field>
                  <p className="mm-note">{t('mm.secrets.reward', { name: secretName(body.secret!) })}</p>
                </div>
              )}
              {body.start && <p className="mm-note">{t('mm.secrets.startNote')}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/** The sun. */
export const SunInspector: React.FC<{ map: CustomMap; onChange: Change; onTransient: (m: CustomMap) => void }> = ({ map, onChange, onTransient }) => {
  useI18n();
  const set = (p: Partial<CustomMap['sun']>) => onChange({ ...map, sun: { ...map.sun, ...p } });
  const live = (p: Partial<CustomMap['sun']>) => onTransient({ ...map, sun: { ...map.sun, ...p } });
  const nameGuard = useNameGuard(map.sun.name);
  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <span className="mm-insp__disc" style={{ background: `radial-gradient(circle at 40% 38%, #fff, ${map.sun.color} 45%, #c2531c)` }} />
        <div className="mm-insp__id">
          <input className="mm-insp__name" value={map.sun.name} aria-label={t('mm.sun.nameAria')} maxLength={24}
            onFocus={nameGuard.onFocus}
            onChange={(e) => live({ name: e.target.value })} onBlur={(e) => set({ name: nameGuard.keep(e.target.value) })} />
          <span className="mm-insp__sub">{t('mm.sun.sub')}</span>
        </div>
      </div>
      <div className="mm-insp__body">
        <div className="mm-sec">{t('mm.sun.star')}</div>
        <div className="mm-row mm-row--wrap">
          {STAR_SWATCHES.map(s => (
            <button key={s.c} className={`mm-chip${map.sun.color === s.c ? ' is-on' : ''}`} onClick={() => set({ color: s.c })}>
              <span className="mm-dot" style={{ background: s.c }} />{starLabel(s.c, s.label)}
            </button>
          ))}
        </div>
        <Field label={t('mm.sizeVal', { n: Math.round(map.sun.size) })}>
          <Slider label={t('mm.sun.sizeAria')} value={map.sun.size} min={SUN_LIMITS.size[0]} max={SUN_LIMITS.size[1]} onChange={(v) => live({ size: v })} onCommit={() => onChange(map)} />
        </Field>
        <Field label={t('mm.sun.mass', { n: map.sun.mass.toFixed(2) })}>
          <Slider label={t('mm.sun.massAria')} value={map.sun.mass} min={SUN_LIMITS.mass[0]} max={SUN_LIMITS.mass[1]} step={0.05} onChange={(v) => live({ mass: v })} onCommit={() => onChange(map)} />
        </Field>
        <p className="mm-note">{t('mm.sun.note')}</p>
      </div>
    </div>
  );
};

/** Nothing selected: the whole map -- its pitch, its sky, its mood. */
export const MapInspector: React.FC<{
  map: CustomMap; theme: string; touch: boolean; onChange: Change; onTransient: (m: CustomMap) => void;
  onDrawSector: () => void; onPickSector: (id: string) => void;
}> = ({ map, theme, touch, onChange, onTransient, onDrawSector, onPickSector }) => {
  useI18n();
  const [confirm, setConfirm] = useState<'inner' | 'outer' | null>(null);
  const reroll = (zone: 'inner' | 'outer') => { const r = rerollZone(map, zone, theme); onChange(r.map, r.ids); setConfirm(null); };
  return (
    <div className="mm-insp">
      <div className="mm-insp__body">
        {map.bodies.length < 3 && (
          <>
            <div className="mm-sec">{t('mm.map.gettingStarted')}</div>
            <ol className="mm-steps">
              <li>{t(touchKey('mm.map.step1', touch))}</li>
              <li>{t(touchKey('mm.map.step2', touch))}</li>
              <li>{t(touchKey('mm.map.step3', touch))}</li>
              <li>{t('mm.map.step4')}</li>
            </ol>
          </>
        )}
        <div className="mm-sec mm-sec--row"><span>{t('mm.map.pitch')}</span><span className="mm-mono">{map.blurb.length}/{TEXT_LIMITS.blurb}</span></div>
        <textarea className="mm-input mm-text" rows={3} maxLength={TEXT_LIMITS.blurb}
          placeholder={t('mm.map.pitchPlaceholder')}
          value={map.blurb} aria-label={t('mm.map.pitchAria')}
          onChange={(e) => onTransient({ ...map, blurb: e.target.value })} onBlur={(e) => onChange({ ...map, blurb: e.target.value })} />
        <p className="mm-note">{t('mm.map.pitchNote')}</p>

        <div className="mm-sec">{t('mm.map.mood')}</div>
        <div className="mm-moods">
          {MOODS.map(m => (
            <button key={m.id} className={`mm-mood is-${m.backdrop}`} onClick={() => onChange(applyMood(map, m))} title={moodBlurb(m)}>
              <span className="mm-mood__sun" style={{ background: m.sun }} />
              <b>{moodLabel(m)}</b>
            </button>
          ))}
        </div>

        <div className="mm-sec">{t('mm.map.sky')}</div>
        <div className="mm-row mm-row--wrap">
          {BACKDROPS.map(bd => (
            <button key={bd} className={`mm-chip is-small mm-bd is-${bd}${map.settings.backdrop === bd ? ' is-on' : ''}`}
              onClick={() => onChange({ ...map, settings: { ...map.settings, backdrop: bd } })}>
              {backdropLabel(bd)}
            </button>
          ))}
        </div>

        <div className="mm-sec mm-sec--row"><span>{t('mm.map.sectors')}</span><span className="mm-mono">{map.sectors.length}/{MAX_SECTORS}</span></div>
        {map.sectors.length === 0 ? (
          <p className="mm-note">{t('mm.map.sectorsNote')}</p>
        ) : (
          <div className="mm-sectors">
            {map.sectors.map(sct => (
              <button key={sct.id} className="mm-sectorrow" onClick={() => onPickSector(sct.id)}>
                <span className="mm-dot" style={{ background: sct.color }} />
                <span className="mm-sectorrow__n">{sct.name}</span>
                <span className="mm-mono">{tn('mm.n.worlds', sectorMembers(map, sct.id).filter(b => b.type !== 'rock').length)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mm-row mm-row--wrap">
          <button className="mm-btn" disabled={map.sectors.length >= MAX_SECTORS} onClick={onDrawSector}>{t('mm.tools.sector')}</button>
          <button className="mm-btn" disabled={map.bodies.length < 2} onClick={() => onChange(suggestSectors(map, Math.max(3, Math.min(6, map.sectors.length || 4))))}>
            {map.sectors.length ? t('mm.map.resuggest') : t('mm.map.suggest')}
          </button>
          {map.sectors.length > 0 && <button className="mm-btn is-danger" onClick={() => onChange(deleteSectors(map, map.sectors.map(x => x.id)))}>{t('mm.map.clearAll')}</button>}
        </div>

        <div className="mm-sec">{t('mm.map.reroll')}</div>
        {confirm ? (
          <div className="mm-box">
            <p className="mm-note">{t(k(`mm.map.rerollAsk.${confirm}`))}</p>
            <div className="mm-row mm-row--end">
              <button className="mm-btn" onClick={() => setConfirm(null)}>{t('mm.map.keep')}</button>
              <button className="mm-btn is-primary" onClick={() => reroll(confirm)}>{t(k(`mm.map.rerollGo.${confirm}`))}</button>
            </div>
          </div>
        ) : (
          <div className="mm-row">
            <button className="mm-btn" disabled={map.bodies.length < 2} onClick={() => setConfirm('inner')}>{t('mm.map.inner')}</button>
            <button className="mm-btn" disabled={map.bodies.length < 2} onClick={() => setConfirm('outer')}>{t('mm.map.outer')}</button>
          </div>
        )}
        {!touch && <p className="mm-note">{t('mm.map.keys', { bodies: tn('mm.n.bodies', map.bodies.length) })}</p>}
      </div>
    </div>
  );
};

/** One sector: its name, colour, edges and the worlds inside. */
export const SectorInspector: React.FC<{
  map: CustomMap; sector: MapSector; onChange: Change; onTransient: (m: CustomMap) => void;
  onSelectWorlds: (ids: string[]) => void;
}> = ({ map, sector, onChange, onTransient, onSelectWorlds }) => {
  useI18n();
  const set = (p: Partial<MapSector>) => onChange(updateSector(map, sector.id, p), [`sector:${sector.id}`]);
  const members = sectorMembers(map, sector.id);
  const worlds = members.filter(b => b.type !== 'rock');
  const starts = members.filter(b => b.start);
  const i = map.sectors.findIndex(x => x.id === sector.id);
  const inside = map.sectors[i - 1], outside = map.sectors[i + 1];
  const nameGuard = useNameGuard(sector.name);
  return (
    <div className="mm-insp">
      <div className="mm-insp__head">
        <span className="mm-sectorbadge" style={{ borderColor: sector.color }} aria-hidden><span style={{ background: sector.color }} /></span>
        <div className="mm-insp__id">
          <input className="mm-insp__name" value={sector.name} aria-label={t('mm.sector.nameAria')} maxLength={24}
            onFocus={nameGuard.onFocus}
            onChange={(e) => onTransient(updateSector(map, sector.id, { name: e.target.value }, false))}
            onBlur={(e) => set({ name: nameGuard.keep(e.target.value) })} />
          <span className="mm-insp__sub">{t('mm.sector.sub', { inner: sector.inner, outer: sector.outer })}</span>
        </div>
      </div>
      <div className="mm-insp__body">
        <div className="mm-sec">{t('mm.colour')}</div>
        <div className="mm-swatches">
          {SECTOR_COLORS.map(c => <button key={c} className={`mm-swatch${sector.color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={t('mm.colourOf', { c })} onClick={() => set({ color: c })} />)}
          <input type="color" className="mm-swatch is-custom" value={sector.color} aria-label={t('mm.anyColour')}
            onChange={(e) => onTransient(updateSector(map, sector.id, { color: e.target.value }, false))} onBlur={(e) => set({ color: e.target.value })} />
        </div>
        <div className="mm-grid2">
          <FieldGroup label={t('mm.sector.innerL')}>
            <Stepper label={t('mm.sector.inner')} value={sector.inner} min={inside ? inside.outer : 0} max={sector.outer - 10} step={10} onChange={(v) => set({ inner: v })} />
          </FieldGroup>
          <FieldGroup label={t('mm.sector.outerL')}>
            <Stepper label={t('mm.sector.outer')} value={sector.outer} min={sector.inner + 10} max={outside ? outside.inner : 15400} step={10} onChange={(v) => set({ outer: v })} />
          </FieldGroup>
        </div>
        <p className="mm-note">{t('mm.sector.edgeNote')}</p>
        <div className="mm-box">
          <b className="mm-sectorstat">{[tn('mm.n.worlds', worlds.length), ...(starts.length ? [tn('mm.n.starts', starts.length)] : [])].join(' · ')}</b>
          <div className="mm-row mm-row--wrap">
            {worlds.slice(0, 18).map(b => <span key={b.id} className="mm-pill">{b.name}</span>)}
            {worlds.length > 18 && <span className="mm-mono">+{worlds.length - 18}</span>}
          </div>
          <p className="mm-note">{t('mm.sector.holdNote', { name: sector.name })}</p>
        </div>
        <div className="mm-row mm-row--end">
          <button className="mm-btn" disabled={!worlds.length} onClick={() => onSelectWorlds(worlds.map(b => b.id))}>{t('mm.sector.selectWorlds')}</button>
          <button className="mm-btn is-danger" onClick={() => onChange(deleteSectors(map, [sector.id]), [])}>{t('mm.sector.delete')}</button>
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
  useI18n();
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
  const range = (key: ResKey) => {
    const vs = bodies.filter(b => b.type !== 'rock').map(b => b.yields[key]);
    return vs.length ? `${Math.min(...vs)}–${Math.max(...vs)}` : '–';
  };
  const apply = (next: CustomMap, select: string[] = ids) => { onChange(next, select); setOpen(null); };
  const toggle = (which: typeof open) => setOpen(open === which ? null : which);
  const roots = bodies.filter(b => b.parent === 'sun').length;
  const rootIds = new Set(bodies.map(b => (b.parent === 'sun' ? b.id : b.parent)));
  const mirrorCost = map.bodies.filter(b => rootIds.has(b.id) || rootIds.has(b.parent)).length;

  return (
    <div className={`mm-bulk${compact ? ' is-compact' : ''}`}>
      {open === 'res' && (
        <div className="mm-pop" role="dialog" aria-label={t('mm.bulk.resAria')}>
          <div className="mm-pop__head">
            <b>{tn('mm.bulk.resTitle', bodies.length)}</b>
            <span className="mm-mono">{t('mm.bulk.now', { metal: range('metal'), credits: range('credits'), science: range('science') })}</span>
          </div>
          <div className="mm-seg">
            {BULK_MODES.map(m => (
              <button key={m} className={`mm-chip${mode === m ? ' is-on' : ''}`} onClick={() => setMode(m)}>{t(k(`mm.bulk.mode.${m}`))}</button>
            ))}
          </div>
          {RES.map(r => {
            const row = rows[r.key];
            const setRow = (p: Partial<typeof row>) => setRows({ ...rows, [r.key]: { ...row, ...p } });
            const res = t(r.labelKey);
            return (
              <div key={r.key} className="mm-res">
                <label className="mm-check is-tight"><input type="checkbox" checked={row.on} onChange={(e) => setRow({ on: e.target.checked })} /><span className={`mm-res__l ${r.cls}`}>{res}</span></label>
                <NumberField className="mm-num" decimal={mode === 'multiply'} step={mode === 'multiply' ? 0.05 : 1}
                  min={mode === 'add' ? -RESOURCE_MAX : 0} max={mode === 'multiply' ? 10 : RESOURCE_MAX}
                  value={row.a} label={t(mode === 'range' ? 'mm.bulk.low' : 'mm.bulk.value', { res })} onCommit={(v) => setRow({ a: v })} />
                {mode === 'range' && (
                  <>
                    <span className="mm-mono">{t('mm.bulk.to')}</span>
                    <NumberField className="mm-num" step={1} min={0} max={RESOURCE_MAX} value={row.b} label={t('mm.bulk.high', { res })} onCommit={(v) => setRow({ b: v })} />
                  </>
                )}
              </div>
            );
          })}
          {mode === 'range' && (
            <label className="mm-check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /><span>{t('mm.bulk.keep')}</span></label>
          )}
          <div className="mm-row mm-row--end">
            <button className="mm-btn" onClick={() => setOpen(null)}>{t('mm.cancel')}</button>
            <button className="mm-btn is-primary" onClick={() => apply(bulkResources(map, ids, rows, mode, keep))}>{t('mm.bulk.applyTo', { n: bodies.length })}</button>
          </div>
        </div>
      )}
      {open === 'size' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>{t('mm.bulk.resize', { n: bodies.length })}</b><span className="mm-mono">×{sizeF.toFixed(2)}</span></div>
          <Slider label={t('mm.bulk.sizeFactor')} value={sizeF} min={0.5} max={2} step={0.05} onChange={setSizeF} />
          <div className="mm-row mm-row--end"><button className="mm-btn is-primary" onClick={() => apply(scaleSize(map, ids, sizeF))}>{t('mm.apply')}</button></div>
        </div>
      )}
      {open === 'name' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>{t('mm.bulk.renameBy', { n: bodies.length })}</b></div>
          <div className="mm-row mm-row--wrap">
            {NAME_THEMES.map(th => <button key={th} className={`mm-chip${nameTheme === th ? ' is-on' : ''}`} onClick={() => setNameTheme(th)}>{themeLabel(th)}</button>)}
          </div>
          <div className="mm-row mm-row--end"><button className="mm-btn is-primary" onClick={() => apply(renameByTheme(map, ids, nameTheme))}>{t('mm.bulk.rename')}</button></div>
        </div>
      )}
      {open === 'color' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>{t('mm.bulk.recolourN', { n: bodies.length })}</b></div>
          <div className="mm-swatches">
            {SWATCHES.map(c => <button key={c} className={`mm-swatch${color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={t('mm.colourOf', { c })} onClick={() => setColor(c)} />)}
            <input type="color" className="mm-swatch is-custom" value={color} aria-label={t('mm.anyColour')} onChange={(e) => setColor(e.target.value)} />
          </div>
          <label className="mm-check"><input type="checkbox" checked={vary} onChange={(e) => setVary(e.target.checked)} /><span>{t('mm.bulk.vary')}</span></label>
          <div className="mm-row mm-row--end"><button className="mm-btn is-primary" onClick={() => apply(recolor(map, ids, color, vary))}>{t('mm.bulk.recolour')}</button></div>
        </div>
      )}
      {open === 'mood' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>{t('mm.bulk.restyle', { n: bodies.length })}</b><span className="mm-mono">{t('mm.bulk.restyleSub')}</span></div>
          <div className="mm-moods">
            {MOODS.map(m => (
              <button key={m.id} className={`mm-mood is-${m.backdrop}`} onClick={() => apply(applyMood(map, m, ids))} title={moodBlurb(m)}>
                <span className="mm-mood__sun" style={{ background: m.sun }} /><b>{moodLabel(m)}</b>
              </button>
            ))}
          </div>
        </div>
      )}
      {open === 'secret' && (
        <div className="mm-pop">
          <div className="mm-pop__head"><b>{tn('mm.bulk.secretsTitle', bodies.length)}</b><span className="mm-mono">{t('mm.bulk.secretsSub')}</span></div>
          <div className="mm-secret-list is-grid">
            {([null, 'random', ...MAP_SECRETS] as Array<MapSecret | 'random' | null>).map(kd => (
              <button key={kd ?? 'none'} className="mm-secret" onClick={() => apply(setSecret(map, ids, kd))}>
                <span className="mm-secret__n">{kd ? secretName(kd) : t('mm.secret.none')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {open === 'mirror' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>{t('mm.bulk.mirrorTitle')}</b><span className="mm-mono">{t('mm.bulk.mirrorCount', { worlds: tn('mm.n.worlds', roots), ways })}</span></div>
          <div className="mm-seg">
            {[2, 3, 4, 5, 6, 8].map(n => <button key={n} className={`mm-chip${ways === n ? ' is-on' : ''}`} onClick={() => setWays(n)}>{t('mm.tools.ways', { n })}</button>)}
          </div>
          <p className="mm-note">{tn('mm.bulk.mirrorNote', ways - 1)}</p>
          {map.bodies.length + mirrorCost * (ways - 1) > MAX_BODIES && (
            <p className="mm-note is-bad">{t('mm.bulk.mirrorFull', { n: mirrorCost * (ways - 1), max: MAX_BODIES, fit: Math.max(0, MAX_BODIES - map.bodies.length) })}</p>
          )}
          <div className="mm-row mm-row--end">
            <button className="mm-btn is-primary" onClick={() => { const r = mirrorBodies(map, ids, ways, theme); apply(r.map, r.ids); }}>{t('mm.bulk.mirrorGo', { n: ways })}</button>
          </div>
        </div>
      )}
      {open === 'match' && (
        <div className="mm-pop is-small">
          <div className="mm-pop__head"><b>{t('mm.bulk.matchTitle')}</b></div>
          <div className="mm-row mm-row--wrap">
            {MATCH_ASPECTS.map(a => (
              <label key={a} className="mm-check is-tight">
                <input type="checkbox" checked={aspects.has(a)} onChange={(e) => { const n = new Set(aspects); if (e.target.checked) n.add(a); else n.delete(a); setAspects(n); }} />
                <span>{t(k(`mm.bulk.aspect.${a}`))}</span>
              </label>
            ))}
          </div>
          <div className="mm-row mm-row--end">
            <button className="mm-btn is-primary" disabled={!aspects.size} onClick={() => { onMatch(aspects); setOpen(null); }}>{t('mm.bulk.pickSource')}</button>
          </div>
        </div>
      )}

      <div className="mm-bulk__bar">
        <span className="mm-bulk__count">{t('mm.bulk.selected', { n: bodies.length })}</span>
        {!compact && <span className="mm-bulk__sep" />}
        <button className={`mm-bbtn${open === 'res' ? ' is-on' : ''}`} onClick={() => toggle('res')}>{t('mm.bulk.resources')}</button>
        <button className={`mm-bbtn${open === 'match' ? ' is-on' : ''}`} onClick={() => toggle('match')}>{t('mm.bulk.match')}</button>
        {roots > 0 && <button className={`mm-bbtn${open === 'mirror' ? ' is-on' : ''}`} onClick={() => toggle('mirror')}>{t('mm.bulk.mirror')}</button>}
        <button className={`mm-bbtn${open === 'size' ? ' is-on' : ''}`} onClick={() => toggle('size')}>{t('mm.bulk.size')}</button>
        {can(b => b.parent === 'sun') && <button className="mm-bbtn" onClick={() => apply(spaceEvenly(map, ids))} title={t('mm.bulk.spaceTitle')}>{t('mm.bulk.space')}</button>}
        <button className={`mm-bbtn${open === 'name' ? ' is-on' : ''}`} onClick={() => toggle('name')}>{t('mm.bulk.rename')}</button>
        <button className={`mm-bbtn${open === 'color' ? ' is-on' : ''}`} onClick={() => toggle('color')}>{t('mm.bulk.recolour')}</button>
        <button className={`mm-bbtn${open === 'mood' ? ' is-on' : ''}`} onClick={() => toggle('mood')}>{t('mm.bulk.mood')}</button>
        {can(b => canStartOn(b.type)) && (
          bodies.every(b => !canStartOn(b.type) || b.start)
            ? <button className="mm-bbtn" onClick={() => apply(markStart(map, ids, false))}>{t('mm.bulk.unmark')}</button>
            : <button className="mm-bbtn" onClick={() => apply(markStart(map, ids, true))}>{t('mm.bulk.mark')}</button>
        )}
        <button className={`mm-bbtn${open === 'secret' ? ' is-on' : ''}`} onClick={() => toggle('secret')}>{t('mm.bulk.secrets')}</button>
        <button className="mm-bbtn" onClick={() => { const r = duplicateBodies(map, ids, theme); onChange(r.map, r.ids); }}>{t('mm.duplicate')}</button>
        <button className="mm-bbtn is-danger" onClick={() => onChange(deleteBodies(map, ids), [])}>{t('mm.delete')}</button>
        <button className="mm-bbtn" onClick={onClear} aria-label={t('mm.bulk.clear')}>✕</button>
      </div>
    </div>
  );
};
