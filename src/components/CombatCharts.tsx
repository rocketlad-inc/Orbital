// ============================================================
// CombatCharts — the numbers behind a fight, drawn.
//
// EVERY VALUE HERE IS COMPUTED, NOT TYPED. The hull stats come from
// SHIP_CLASSES and the odds from hitChanceOf() — the same table and the
// same function the server fires with. A reference chart that restates
// balance numbers by hand is a chart that silently lies the first time
// someone retunes a hull, and this game retunes hulls often (the
// corvette went 3.75 -> 7 damage mid-playtest). Nothing below can drift.
//
// FORM. Two of these are grids of one magnitude (odds; expected damage),
// so they are heatmaps on a single-hue sequential ramp — more is
// brighter, because the surface is dark. The hull stats are three
// measures on wildly different scales (HP 40-400, damage 0-45, speed
// 0.3-0.85), so they are three separate single-series bars rather than
// one chart with three axes; a dual-axis chart is the one thing you may
// never do. Every cell and bar carries its own number, so identity is
// never colour alone.
//
// COLOUR. Teal #26a69a and amber #c98500, validated against the landing
// surface #0a0e14: both inside the dark lightness band, worst-pair CVD
// separation 14.2 (target 8), normal-vision 20.8 (floor 15), contrast
// over 3:1. They are deliberately a shade deeper than the game's own
// #4ecdc4/#ffb84d, which sit above the band and fail it.
//
// SINGLE THEME on purpose: this page only ever renders on the dark
// landing surface, so there is no light mode to design for.
// ============================================================

import React from 'react';
import { SHIP_CLASSES, ShipClassName } from '../game/shipClasses';
import { hitChanceOf, DAMAGE_MITIGATION_PER_PART } from '../game/shipParts';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './CombatCharts.css';

/** Hulls that can shoot, in speed order (fast first) — the order is the
 *  story, since speed is what drives every number on the page. */
const ARMED: ShipClassName[] = ['corvette', 'frigate', 'destroyer'];
/** Everything that can be shot AT. Freighters never fire but are very
 *  much a target, and leaving them out would hide how safe they aren't. */
const TARGETS: ShipClassName[] = ['corvette', 'frigate', 'destroyer', 'freighter'];

/** "a **b** c" -> a, <b>b</b>, c. The catalog marks bold with ** so word order can differ per language. */
const rich = (s: string): React.ReactNode[] =>
  s.split('**').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));

const stat = (c: ShipClassName) => SHIP_CLASSES[c];
const label = (c: ShipClassName) => c.charAt(0).toUpperCase() + c.slice(1);

/** Sequential teal ramp, 0..1 -> dark..bright. Lightness is monotonic in
 *  t, which is the only real requirement for a sequential scale. */
function ramp(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const l = 12 + k * 46;              // 12% -> 58% lightness
  const s = 30 + k * 32;              // duller at the low end
  return `hsl(174 ${s}% ${l}%)`;
}
/** Ink that stays legible as the cell brightens. */
const cellInk = (t: number) => (t > 0.62 ? '#04120f' : '#cfe6e2');

interface BarRowProps { name: string; value: number; max: number; fmt: (n: number) => string; }
const BarRow: React.FC<BarRowProps> = ({ name, value, max, fmt }) => (
  <div className="cc-barrow">
    <div className="cc-barname">{name}</div>
    <div className="cc-bartrack">
      <div className="cc-barfill" style={{ width: `${Math.max(2, (100 * value) / max)}%` }} />
    </div>
    <div className="cc-barval">{fmt(value)}</div>
  </div>
);

const Matrix: React.FC<{
  title: string;
  caption: string;
  cell: (atk: ShipClassName, def: ShipClassName) => { t: number; text: string; title: string };
}> = ({ title, caption, cell }) => {
  useI18n();
  return (
  <figure className="cc-fig">
    <figcaption className="cc-figcap">
      <span className="cc-figtitle">{title}</span>
      <span className="cc-figsub">{caption}</span>
    </figcaption>
    <div className="cc-matrixwrap">
      <table className="cc-matrix">
        <thead>
          <tr>
            <th scope="col" className="cc-corner">{t('combat.matrix.corner')}</th>
            {TARGETS.map(d => <th scope="col" key={d}>{label(d)}</th>)}
          </tr>
        </thead>
        <tbody>
          {ARMED.map(a => (
            <tr key={a}>
              <th scope="row">{label(a)}</th>
              {TARGETS.map(d => {
                const c = cell(a, d);
                return (
                  <td key={d}>
                    <span
                      className="cc-cell"
                      style={{ background: ramp(c.t), color: cellInk(c.t) }}
                      title={c.title}
                    >
                      {c.text}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </figure>
  );
};

export const CombatCharts: React.FC = () => {
  useI18n();
  const maxHp = Math.max(...TARGETS.map(c => stat(c).hp));
  const maxDmg = Math.max(...TARGETS.map(c => stat(c).damagePerTick));
  const maxSpd = Math.max(...TARGETS.map(c => stat(c).speed));
  // Scale expected damage against the worst case on the board, so the two
  // matrices are not accidentally on different footings.
  const maxExp = Math.max(
    ...ARMED.flatMap(a => TARGETS.map(d =>
      stat(a).damagePerTick * hitChanceOf(stat(a).speed, stat(d).speed))),
  );

  return (
    <section className="cc">
      <h2 className="cc-h2">{t('combat.title')}</h2>
      <p className="cc-lede">
        {t('combat.lede')}
      </p>

      <Matrix
        title={t('combat.hit.title')}
        caption={t('combat.hit.caption')}
        cell={(a, d) => {
          const p = hitChanceOf(stat(a).speed, stat(d).speed);
          return {
            t: p,
            text: `${Math.round(p * 100)}%`,
            title: t('combat.hit.cell', { a: label(a), d: label(d), p: Math.round(p * 100) }),
          };
        }}
      />

      <p className="cc-note">
        {rich(t('combat.note.corners', {
          a: Math.round(hitChanceOf(stat('corvette').speed, stat('destroyer').speed) * 100),
          b: Math.round(hitChanceOf(stat('destroyer').speed, stat('corvette').speed) * 100),
        }))}
      </p>

      <Matrix
        title={t('combat.exp.title')}
        caption={t('combat.exp.caption')}
        cell={(a, d) => {
          const p = hitChanceOf(stat(a).speed, stat(d).speed);
          const dmg = stat(a).damagePerTick * p;
          return {
            t: maxExp > 0 ? dmg / maxExp : 0,
            text: dmg.toFixed(1),
            title: t('combat.exp.cell', {
              a: label(a), d: label(d), base: stat(a).damagePerTick,
              p: Math.round(p * 100), dmg: dmg.toFixed(1),
            }),
          };
        }}
      />

      <p className="cc-note">
        {rich(t('combat.note.accuracy', {
          x: (stat('destroyer').damagePerTick / stat('corvette').damagePerTick).toFixed(0),
          dmg: stat('destroyer').damagePerTick,
          eff: (stat('destroyer').damagePerTick
            * hitChanceOf(stat('destroyer').speed, stat('corvette').speed)).toFixed(1),
        }))}
      </p>

      <div className="cc-grid3">
        <figure className="cc-fig">
          <figcaption className="cc-figcap">
            <span className="cc-figtitle">{t('combat.hp')}</span>
          </figcaption>
          {TARGETS.map(c => (
            <BarRow key={c} name={label(c)} value={stat(c).hp} max={maxHp}
              fmt={n => String(n)} />
          ))}
        </figure>
        <figure className="cc-fig">
          <figcaption className="cc-figcap">
            <span className="cc-figtitle">{t('combat.damage')}</span>
          </figcaption>
          {TARGETS.map(c => (
            <BarRow key={c} name={label(c)} value={stat(c).damagePerTick} max={maxDmg}
              fmt={n => (n === 0 ? '—' : String(n))} />
          ))}
        </figure>
        <figure className="cc-fig">
          <figcaption className="cc-figcap">
            <span className="cc-figtitle">{t('combat.speed')}</span>
            <span className="cc-figsub">{t('combat.speed.sub')}</span>
          </figcaption>
          {TARGETS.map(c => (
            <BarRow key={c} name={label(c)} value={stat(c).speed} max={maxSpd}
              fmt={n => n.toFixed(2)} />
          ))}
        </figure>
      </div>

      {/* Two identities, so this one is categorical — and the pair is
          validated. Each row is also labelled, so the colour is a second
          cue rather than the only one. */}
      <figure className="cc-fig">
        <figcaption className="cc-figcap">
          <span className="cc-figtitle">{t('combat.counters.title')}</span>
          <span className="cc-figsub">
            {t('combat.counters.sub', { pct: Math.round((1 - DAMAGE_MITIGATION_PER_PART) * 100) })}
          </span>
        </figcaption>
        <div className="cc-counters">
          <div className="cc-counter">
            <span className="cc-swatch" style={{ background: '#26a69a' }} />
            <span className="cc-ctext">{rich(t('combat.counter.kinetic'))}</span>
          </div>
          <div className="cc-counter">
            <span className="cc-swatch" style={{ background: '#c98500' }} />
            <span className="cc-ctext">{rich(t('combat.counter.energy'))}</span>
          </div>
        </div>
        <div className="cc-mit">
          {[1, 2, 3].map(n => {
            const cut = 1 - Math.pow(DAMAGE_MITIGATION_PER_PART, n);
            return (
              <div className="cc-mitrow" key={n}>
                <div className="cc-barname">{tn('combat.parts', n)}</div>
                <div className="cc-bartrack">
                  <div className="cc-barfill cc-barfill--mit" style={{ width: `${cut * 100}%` }} />
                </div>
                <div className="cc-barval">−{Math.round(cut * 100)}%</div>
              </div>
            );
          })}
        </div>
        <p className="cc-note cc-note--tight">
          {t('combat.wrongDefence')}
        </p>
      </figure>
    </section>
  );
};
