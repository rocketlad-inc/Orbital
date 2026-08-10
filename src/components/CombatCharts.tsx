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
import './CombatCharts.css';

/** Hulls that can shoot, in speed order (fast first) — the order is the
 *  story, since speed is what drives every number on the page. */
const ARMED: ShipClassName[] = ['corvette', 'frigate', 'destroyer'];
/** Everything that can be shot AT. Freighters never fire but are very
 *  much a target, and leaving them out would hide how safe they aren't. */
const TARGETS: ShipClassName[] = ['corvette', 'frigate', 'destroyer', 'freighter'];

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
}> = ({ title, caption, cell }) => (
  <figure className="cc-fig">
    <figcaption className="cc-figcap">
      <span className="cc-figtitle">{title}</span>
      <span className="cc-figsub">{caption}</span>
    </figcaption>
    <div className="cc-matrixwrap">
      <table className="cc-matrix">
        <thead>
          <tr>
            <th scope="col" className="cc-corner">firing ↓ / at →</th>
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

export const CombatCharts: React.FC = () => {
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
      <h2 className="cc-h2">The numbers behind a fight</h2>
      <p className="cc-lede">
        Ships fire every tick. Whether a shot lands is decided by speed alone:
        a fast hull is hard to hit, and it does not matter how big the gun is.
        Everything below is read live from the game's own combat tables, so it
        is what your ships are actually doing right now.
      </p>

      <Matrix
        title="Chance to hit"
        caption="attacker speed² ÷ (attacker² + defender²) — mirrors are always 50%"
        cell={(a, d) => {
          const p = hitChanceOf(stat(a).speed, stat(d).speed);
          return {
            t: p,
            text: `${Math.round(p * 100)}%`,
            title: `A ${label(a)} firing at a ${label(d)} hits ${Math.round(p * 100)}% of the time.`,
          };
        }}
      />

      <p className="cc-note">
        Read the corners. A corvette hits a destroyer{' '}
        <b>{Math.round(hitChanceOf(stat('corvette').speed, stat('destroyer').speed) * 100)}%</b>{' '}
        of the time; the destroyer shooting back lands{' '}
        <b>{Math.round(hitChanceOf(stat('destroyer').speed, stat('corvette').speed) * 100)}%</b>.
        That gap is the whole reason small hulls still matter.
      </p>

      <Matrix
        title="Expected damage per tick"
        caption="base damage × chance to hit — what the shot is actually worth"
        cell={(a, d) => {
          const p = hitChanceOf(stat(a).speed, stat(d).speed);
          const dmg = stat(a).damagePerTick * p;
          return {
            t: maxExp > 0 ? dmg / maxExp : 0,
            text: dmg.toFixed(1),
            title: `${label(a)} → ${label(d)}: ${stat(a).damagePerTick} base × `
              + `${Math.round(p * 100)}% = ${dmg.toFixed(1)} damage per tick.`,
          };
        }}
      />

      <p className="cc-note">
        Accuracy is why a destroyer is not simply {(stat('destroyer').damagePerTick
          / stat('corvette').damagePerTick).toFixed(0)}× a corvette. Against a
        corvette its {stat('destroyer').damagePerTick} damage lands as{' '}
        <b>{(stat('destroyer').damagePerTick
          * hitChanceOf(stat('destroyer').speed, stat('corvette').speed)).toFixed(1)}</b>.
      </p>

      <div className="cc-grid3">
        <figure className="cc-fig">
          <figcaption className="cc-figcap">
            <span className="cc-figtitle">Hull HP</span>
          </figcaption>
          {TARGETS.map(c => (
            <BarRow key={c} name={label(c)} value={stat(c).hp} max={maxHp}
              fmt={n => String(n)} />
          ))}
        </figure>
        <figure className="cc-fig">
          <figcaption className="cc-figcap">
            <span className="cc-figtitle">Base damage / tick</span>
          </figcaption>
          {TARGETS.map(c => (
            <BarRow key={c} name={label(c)} value={stat(c).damagePerTick} max={maxDmg}
              fmt={n => (n === 0 ? '—' : String(n))} />
          ))}
        </figure>
        <figure className="cc-fig">
          <figcaption className="cc-figcap">
            <span className="cc-figtitle">Speed</span>
            <span className="cc-figsub">drives accuracy both ways</span>
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
          <span className="cc-figtitle">Guns and their counters</span>
          <span className="cc-figsub">
            each matching defensive part cuts that damage type by{' '}
            {Math.round((1 - DAMAGE_MITIGATION_PER_PART) * 100)}%, compounding
          </span>
        </figcaption>
        <div className="cc-counters">
          <div className="cc-counter">
            <span className="cc-swatch" style={{ background: '#26a69a' }} />
            <span className="cc-ctext"><b>Kinetic</b> is stopped by <b>Shields</b></span>
          </div>
          <div className="cc-counter">
            <span className="cc-swatch" style={{ background: '#c98500' }} />
            <span className="cc-ctext"><b>Energy</b> is stopped by <b>Armour</b></span>
          </div>
        </div>
        <div className="cc-mit">
          {[1, 2, 3].map(n => {
            const cut = 1 - Math.pow(DAMAGE_MITIGATION_PER_PART, n);
            return (
              <div className="cc-mitrow" key={n}>
                <div className="cc-barname">{n} part{n > 1 ? 's' : ''}</div>
                <div className="cc-bartrack">
                  <div className="cc-barfill cc-barfill--mit" style={{ width: `${cut * 100}%` }} />
                </div>
                <div className="cc-barval">−{Math.round(cut * 100)}%</div>
              </div>
            );
          })}
        </div>
        <p className="cc-note cc-note--tight">
          The wrong defence does nothing at all — shields do not slow an energy
          beam. Since metal buys kinetic guns and shields while credits buy
          energy guns and armour, a fleet built on one currency carries a
          defence its enemy simply ignores.
        </p>
      </figure>
    </section>
  );
};
