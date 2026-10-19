// ============================================================
// WmSilo — the Missile Silo's panel in the world menu (worker/missiles.js).
//
// Lorne, 2026-10-19: a city building that builds, stores and fires
// single-use missiles. The panel takes the yard box's place when its tab
// is picked (WorldMenuOverlay), and holds three things:
//   BUILD    — order missiles (40m + 40c, 12 ticks, one at a time), the
//              queue with its countdown, cancel for a full refund
//   LAUNCH   — a world in this star system, a salvo size, what it would do
//              (10 damage per missile to EVERY ship in that orbit, yours
//              too), and a confirm when it would hit your own ships
//   AUTO-DEFENCE — off / shoot down incoming missiles / also hostile
//              fleets landing here, and a reserve it never spends
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { humanizeMpError } from './errorMessages';
import { makePeaceCheck } from '../game/peace';
import type { Body, Settlement, Ship } from '../types';
import { t, tn, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './WmSilo.css';

export const MISSILE_DAMAGE = 10;
export const MISSILE_COST = { ore: 40, credits: 40 };
export const MISSILE_BUILD_TICKS = 12;
export const MISSILES_PER_LEVEL = 5;
const ME = 'player';

/** The star system a body is in: Sol's, or a far system's barycentre.
 *  Mirrors starSystemOf in worker/missiles.js. */
export function starSystemOf(bodyId: string, byId: ReadonlyMap<string, Body>): string | null {
  let cur = byId.get(bodyId);
  for (let hops = 0; hops < 16 && cur; hops++) {
    if (cur.id === 'binary_barycenter' || cur.id === 'bh_barycenter') return cur.id;
    if (!cur.parent) return cur.id;
    cur = byId.get(cur.parent);
  }
  return cur?.id ?? null;
}

type OrbitStat = { body: Body; ships: Ship[]; mine: number; hostile: number; total: number };

export const WmSilo: React.FC<{
  city: Settlement;
  body: Body;
  mobile: boolean;
  tabs: React.ReactNode;
  onErr: (m: string | null) => void;
}> = ({ city, body, mobile, tabs, onErr }) => {
  useI18n();
  const { gameState } = useGameContext();
  const actions = useMultiplayerActions();
  const silo = city.missileSilo;
  const level = Number(city.buildings?.missile_silo ?? 0);
  const cap = MISSILES_PER_LEVEL * level;
  const tick = gameState.currentTick ?? 0;
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [salvo, setSalvo] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const [eta, setEta] = useState<Record<string, number>>({});

  const byId = useMemo(() => new Map(gameState.bodies.map(b => [b.id, b])), [gameState.bodies]);
  const atPeace = useMemo(() => makePeaceCheck(gameState.warPairs), [gameState.warPairs]);
  const home = starSystemOf(body.id, byId);

  // Every other world in this star system, with what sits in its orbit.
  const worlds: OrbitStat[] = useMemo(() => {
    const parked = new Map<string, Ship[]>();
    for (const s of gameState.ships) {
      if (s.class === 'missile' || s.transit || !s.orbit?.parentBodyId) continue;
      const list = parked.get(s.orbit.parentBodyId) ?? [];
      list.push(s);
      parked.set(s.orbit.parentBodyId, list);
    }
    return gameState.bodies
      .filter(b => b.id !== body.id && b.type !== 'star' && starSystemOf(b.id, byId) === home)
      .map(b => {
        const ships = parked.get(b.id) ?? [];
        const mine = ships.filter(s => s.ownedBy === ME).length;
        const hostile = ships.filter(s => s.ownedBy !== ME && !atPeace(ME, s.ownedBy)).length;
        return { body: b, ships, mine, hostile, total: ships.length };
      })
      .filter(w => w.total > 0 || w.body.id === target)
      .sort((a, b) => (b.hostile - a.hostile) || (b.total - a.total));
  }, [gameState.ships, gameState.bodies, body.id, byId, home, atPeace, target]);

  // ETAs for the list, asked once per opening.
  useEffect(() => {
    if (!picking || !actions) return;
    const ids = worlds.map(w => w.body.id).filter(id => eta[id] == null).slice(0, 30);
    if (ids.length === 0) return;
    let live = true;
    void actions.missileEta(body.id, ids).then(r => { if (live) setEta(e => ({ ...e, ...r })); });
    return () => { live = false; };
  }, [picking, actions, worlds, body.id, eta]);

  if (!silo) return null;
  const stock = silo.stock;
  const queued = silo.orders.length;
  const room = Math.max(0, cap - stock - queued);
  const pool = gameState.resources?.[ME];
  const canAfford = !pool || ((pool.ore ?? 0) >= MISSILE_COST.ore && (pool.credits ?? 0) >= MISSILE_COST.credits);
  const chosen = worlds.find(w => w.body.id === target) ?? null;
  const n = Math.max(1, Math.min(salvo, stock));
  const damage = MISSILE_DAMAGE * n;
  const kills = chosen ? chosen.ships.filter(s => (s.hp ?? s.hpMax ?? 1) <= damage) : [];
  const myKills = kills.filter(s => s.ownedBy === ME).length;
  const inFlight = gameState.ships.filter(s => s.class === 'missile' && s.ownedBy === ME && s.transit);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; code?: string }>) => {
    setBusy(key); onErr(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) onErr(humanizeMpError(res.code, res.error ?? t('worldmenu.silo.err.failed'), 'build'));
    return res.ok;
  };
  const order = () => actions && run('order', () => actions.orderMissiles(city.id, 1));
  const cancel = (id: string) => actions && run(`c${id}`, () => actions.cancelMissile(city.id, id));
  const setAuto = (auto: 'off' | 'missiles' | 'fleets') => actions && run('auto', () => actions.setMissileDefence(city.id, { auto }));
  const setReserve = (reserve: number) => actions && run('auto', () => actions.setMissileDefence(city.id, { reserve: Math.max(0, Math.min(cap, reserve)) }));
  const launch = async () => {
    if (!actions || !chosen) return;
    if (chosen.mine > 0 && !confirm) { setConfirm(true); return; }
    const ok = await run('launch', () => actions.launchMissiles(city.id, chosen.body.id, n));
    if (ok) { setConfirm(false); setSalvo(1); }
  };

  const pips = Array.from({ length: cap }, (_, i) => (i < stock ? 'full' : i < stock + queued ? 'queued' : 'empty'));

  return (
    <section className={`wm-fleet wm-silo${mobile ? ' is-mobile' : ''}`}
      style={mobile ? undefined : { left: 'calc(var(--wm-rail) + (100vw - var(--wm-rail) - var(--wm-dock)) / 2)', transform: 'translateX(-50%)' }}
      aria-label={t('worldmenu.silo.aria')} data-testid="wm-silo">
      {tabs}
      <header className="wm-silo-head">
        <span className="wm-silo-title">{t('worldmenu.silo.title')}</span>
        <span className="wm-silo-sub">{t('worldmenu.silo.level', { name: city.name, n: level })}</span>
        <span className="wm-silo-fill" />
        <span className="wm-silo-mag-l">{t('worldmenu.silo.magazine')}</span>
        <span className="wm-silo-pips" aria-label={t('worldmenu.silo.magAria', { n: stock, cap })}>
          {pips.map((p, i) => <i key={i} className={`is-${p}`} />)}
        </span>
        <span className="wm-silo-count">{stock}<span> / {cap}</span></span>
      </header>

      <div className="wm-silo-cols">
        <div className="wm-silo-col">
          <span className="wm-silo-h">{t('worldmenu.silo.build')}</span>
          <div className="wm-silo-buildrow">
            <span className="wm-silo-bname">{t('worldmenu.silo.missile')}</span>
            <span className="wm-silo-cost">{MISSILE_COST.ore}m · <b>{MISSILE_COST.credits}c</b> · {MISSILE_BUILD_TICKS}t</span>
            <button type="button" className="wm-silo-btn is-teal" disabled={busy !== null || room === 0 || !canAfford}
              title={room === 0 ? t('worldmenu.silo.full') : !canAfford ? t('worldmenu.silo.cantAfford') : undefined} onClick={order}>
              {busy === 'order' ? '…' : t('worldmenu.silo.buildBtn')}
            </button>
          </div>
          <div className="wm-silo-queue">
            {silo.orders.length === 0 && <span className="wm-silo-note">{room === 0 ? t('worldmenu.silo.fullNote') : t('worldmenu.silo.idle')}</span>}
            {silo.orders.map((o, i) => {
              const left = o.completeTick != null ? Math.max(0, o.completeTick - tick) : null;
              const pct = o.startTick != null && o.completeTick != null && o.completeTick > o.startTick
                ? Math.min(1, Math.max(0, (tick - o.startTick) / (o.completeTick - o.startTick))) : 0;
              return (
                <div key={o.id} className="wm-silo-qrow">
                  <span className="wm-silo-qn">{i + 1}</span>
                  <span className="wm-silo-qname">{t('worldmenu.silo.missile')}</span>
                  <span className="wm-silo-qt">{left != null ? `T-${left}` : t('worldmenu.silo.waiting')}</span>
                  <button type="button" className="wm-silo-x" aria-label={t('worldmenu.silo.cancelAria')} disabled={busy !== null}
                    onClick={() => cancel(o.id)}>✕</button>
                  {i === 0 && <i className="wm-silo-bar" style={{ width: `${Math.round(pct * 100)}%` }} />}
                </div>
              );
            })}
          </div>
          <span className="wm-silo-note">{t('worldmenu.silo.buildNote')}</span>
        </div>

        <div className="wm-silo-col">
          <span className="wm-silo-h">{t('worldmenu.silo.launch')}</span>
          <button type="button" className="wm-silo-target" aria-expanded={picking} onClick={() => setPicking(p => !p)}>
            {chosen ? (
              <>
                <span className="wm-silo-tname">{chosen.body.name}</span>
                <span className="wm-silo-tmeta">{tn('worldmenu.silo.shipsThere', chosen.total)}{chosen.hostile ? ` · ${tn('worldmenu.silo.hostile', chosen.hostile)}` : ''}</span>
                <span className="wm-silo-tmeta">{eta[chosen.body.id] != null ? t('worldmenu.silo.eta', { n: eta[chosen.body.id] }) : ''}</span>
              </>
            ) : <span className="wm-silo-tname is-dim">{t('worldmenu.silo.pickTarget')}</span>}
            <span aria-hidden>▾</span>
          </button>
          {picking && (
            <div className="wm-silo-list" role="listbox" aria-label={t('worldmenu.silo.pickTarget')}>
              {worlds.length === 0 && <span className="wm-silo-note">{t('worldmenu.silo.noTargets')}</span>}
              {worlds.map(w => (
                <button key={w.body.id} type="button" role="option" aria-selected={w.body.id === target}
                  className={`wm-silo-opt${w.body.id === target ? ' is-on' : ''}`}
                  onClick={() => { setTarget(w.body.id); setPicking(false); setConfirm(false); }}>
                  <span className="wm-silo-tname">{w.body.name}</span>
                  <span className="wm-silo-tmeta">{eta[w.body.id] != null ? t('worldmenu.silo.eta', { n: eta[w.body.id] }) : '…'}</span>
                  <span className="wm-silo-tmeta is-wide">
                    {tn('worldmenu.silo.shipsThere', w.total)}
                    {w.hostile ? <b className="is-hostile"> · {tn('worldmenu.silo.hostile', w.hostile)}</b> : null}
                    {w.mine ? <b className="is-mine"> · {tn('worldmenu.silo.yours', w.mine)}</b> : null}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="wm-silo-salvo">
            <span className="wm-silo-h2">{t('worldmenu.silo.salvo')}</span>
            <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.fewer')} disabled={n <= 1} onClick={() => { setSalvo(Math.max(1, n - 1)); setConfirm(false); }}>−</button>
            <span className="wm-silo-num">{stock > 0 ? n : 0}</span>
            <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.more')} disabled={n >= stock} onClick={() => { setSalvo(Math.min(stock, n + 1)); setConfirm(false); }}>+</button>
            <span className="wm-silo-note">{t('worldmenu.silo.ofReady', { n: stock })}</span>
          </div>
          {chosen && stock > 0 && (
            <div className={`wm-silo-preview${chosen.mine > 0 ? ' is-warn' : ''}`}>
              <span className="is-strong">{t('worldmenu.silo.previewDamage', { dmg: damage, world: chosen.body.name })}</span>
              <span>{t('worldmenu.silo.previewKills', { n: kills.length, total: chosen.total })}</span>
              {chosen.mine > 0 && <span className="is-mine">{t('worldmenu.silo.previewMine', { n: chosen.mine, k: myKills })}</span>}
            </div>
          )}
          <div className="wm-silo-launchrow">
            <button type="button" className={`wm-silo-btn is-fire${confirm ? ' is-confirm' : ''}`}
              disabled={busy !== null || !chosen || stock === 0} onClick={launch}>
              {busy === 'launch' ? '…' : confirm ? t('worldmenu.silo.confirmFire', { n }) : t('worldmenu.silo.fire', { n: stock > 0 ? n : 0 })}
            </button>
            {confirm && <button type="button" className="wm-silo-btn" onClick={() => setConfirm(false)}>{t('worldmenu.silo.back')}</button>}
          </div>
          {inFlight.length > 0 && (
            <span className="wm-silo-note">
              {t('worldmenu.silo.inFlight')}{' '}
              {inFlight.map(s => {
                const tr = s.transit!.currentTransfer;
                const to = byId.get(tr.targetBodyId)?.name ?? '?';
                return `${s.missileCount ?? 1} → ${to} T-${Math.max(0, Math.ceil(tr.arriveTick - tick))}`;
              }).join(' · ')}
            </span>
          )}
        </div>

        <div className="wm-silo-col">
          <span className="wm-silo-h">{t('worldmenu.silo.auto')}</span>
          <div className="wm-silo-seg" role="group" aria-label={t('worldmenu.silo.auto')}>
            {(['off', 'missiles', 'fleets'] as const).map(m => (
              <button key={m} type="button" aria-pressed={silo.auto === m} className={silo.auto === m ? 'is-on' : ''}
                disabled={busy !== null} onClick={() => setAuto(m)}>{t(`worldmenu.silo.mode.${m}` as Key)}</button>
            ))}
          </div>
          <span className="wm-silo-note is-body">{t(`worldmenu.silo.modeNote.${silo.auto}` as Key)}</span>
          <div className="wm-silo-salvo">
            <span className="wm-silo-h2">{t('worldmenu.silo.reserve')}</span>
            <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.fewer')} disabled={busy !== null || silo.reserve <= 0} onClick={() => setReserve(silo.reserve - 1)}>−</button>
            <span className="wm-silo-num">{silo.reserve}</span>
            <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.more')} disabled={busy !== null || silo.reserve >= cap} onClick={() => setReserve(silo.reserve + 1)}>+</button>
          </div>
          {silo.auto !== 'off' && (
            <span className="wm-silo-watch"><i />{t('worldmenu.silo.watching', { world: body.name, n: Math.max(0, stock - silo.reserve) })}</span>
          )}
        </div>
      </div>
    </section>
  );
};

export default WmSilo;
