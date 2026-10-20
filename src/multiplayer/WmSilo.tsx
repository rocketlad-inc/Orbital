// ============================================================
// WmSilo — the Missile Silo's panel in the world menu (worker/missiles.js).
//
// Lorne, 2026-10-19: a city building that builds, stores and fires
// single-use missiles. The panel takes the yard box's place when its tab
// is picked (WorldMenuOverlay), and holds, in this order:
//   INCOMING — every hostile group flying at THIS world: when it lands,
//              when a salvo leaving now would meet it, what that salvo
//              would do, and a launch on each row. Intercepting raids is
//              the silo's main job (Lorne, 2026-10-20: "the PRIMARY use
//              is to intercept incoming ships"), so it leads. Under it,
//              folded, OTHER TARGETS: a world's orbit (10 per missile to
//              EVERY ship there, a confirm when yours are among them) or
//              ships bound elsewhere
//   AUTO-DEFENCE — off / shoot down incoming missiles / also intercept
//              hostile ships flying here (a salvo per group), and a
//              reserve it never spends
//   BUILD    — order missiles (40m + 40c, 12 ticks, one at a time), the
//              queue with its countdown, cancel for a full refund
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { humanizeMpError } from './errorMessages';
import { makePeaceCheck } from '../game/peace';
import { groupFlights, type FlightGroup } from '../game/interceptPicker';
import type { Body, Settlement, Ship } from '../types';
import { t, tn, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './WmSilo.css';

export const MISSILE_DAMAGE = 10;
export const MISSILE_COST = { ore: 40, credits: 40 };
export const MISSILE_BUILD_TICKS = 12;
export const MISSILES_PER_LEVEL = 5;
/** Mirrors MISSILE_BLAST_RADIUS in worker/missiles.js. */
export const MISSILE_BLAST_RADIUS = 40;
/** A target in flight is keyed by its group's lead hull. */
const GROUP = 'grp:';
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
  // Which of the two other-target lists is open: ships bound elsewhere,
  // or worlds to strike. Never both.
  const [fold, setFold] = useState<null | 'ships' | 'worlds'>(null);
  // Narrows the open list (Lorne, 2026-10-20: "we need a search bar for
  // targets"). Cleared whenever the other list is opened.
  const [query, setQuery] = useState('');
  const [salvo, setSalvo] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const [eta, setEta] = useState<Record<string, number>>({});
  const [meets, setMeets] = useState<Record<string, number | null>>({});
  // Your own hulls a burst at that meeting would catch (Lorne's list,
  // 2026-10-20: warn before a late launch hits your parked fleet).
  const [ownHits, setOwnHits] = useState<Record<string, { n: number; world: string | null }>>({});
  // A raid already enough missiles are flying at: LAUNCH asks once more.
  const [overConfirm, setOverConfirm] = useState<string | null>(null);

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

  // Other empires' ships in flight to worlds of this star system, one row
  // per group (the intercept picker's grouping), hostile first.
  const groups: FlightGroup[] = useMemo(() => {
    const flying = gameState.ships.filter(s => {
      const to = s.transit?.currentTransfer?.targetBodyId;
      return s.class !== 'missile' && s.ownedBy !== ME && !!to && starSystemOf(to, byId) === home;
    });
    return groupFlights(flying, gameState.fleets ?? []).sort((a, b) => {
      const ha = atPeace(ME, a.lead.ownedBy) ? 1 : 0;
      const hb = atPeace(ME, b.lead.ownedBy) ? 1 : 0;
      return (ha - hb) || ((a.lead.transit?.currentTransfer?.arriveTick ?? 0) - (b.lead.transit?.currentTransfer?.arriveTick ?? 0));
    });
  }, [gameState.ships, gameState.fleets, byId, home, atPeace]);
  // INCOMING: hostile groups bound for THIS world. Intercepting them is
  // what a silo is for (Lorne, 2026-10-20: "the PRIMARY use is to
  // intercept incoming ships"), so they lead the panel, soonest first.
  const incoming = groups.filter(g => g.lead.transit?.currentTransfer?.targetBodyId === body.id && !atPeace(ME, g.lead.ownedBy));
  const others = groups.filter(g => !incoming.includes(g));
  const incomingKeys = incoming.map(g => g.lead.id).join(',');
  const groupKeys = groups.map(g => g.lead.id).join(',');
  const ownerName = (fid: string) => gameState.factions.find(f => f.id === fid)?.name ?? t('worldmenu.silo.unknownEmpire');

  // When a salvo leaving now would meet each group: the server's answer
  // (missiles.js planIntercept). The incoming groups always, every tick
  // (the answer moves as they close); the rest when the picker opens.
  useEffect(() => {
    if (!actions) return;
    const ids = (fold === 'ships' ? groupKeys : incomingKeys).split(',').filter(Boolean).slice(0, 30);
    if (ids.length === 0) return;
    let live = true;
    void actions.missileIntercepts(body.id, ids).then(r => {
      if (!live) return;
      const m: Record<string, number | null> = {};
      const h: Record<string, { n: number; world: string | null }> = {};
      for (const [k, v] of Object.entries(r)) { m[k] = v ? v.ticks : null; if (v) h[k] = v.ownHits; }
      setMeets(x => ({ ...x, ...m }));
      setOwnHits(x => ({ ...x, ...h }));
    });
    return () => { live = false; };
  }, [fold, actions, groupKeys, incomingKeys, body.id, tick]);

  // ETAs for the list, asked once per opening.
  useEffect(() => {
    if (fold !== 'worlds' || !actions) return;
    const ids = worlds.map(w => w.body.id).filter(id => eta[id] == null).slice(0, 30);
    if (ids.length === 0) return;
    let live = true;
    void actions.missileEta(body.id, ids).then(r => { if (live) setEta(e => ({ ...e, ...r })); });
    return () => { live = false; };
  }, [fold, actions, worlds, body.id, eta]);

  if (!silo) return null;
  const stock = silo.stock;
  const queued = silo.orders.length;
  const room = Math.max(0, cap - stock - queued);
  const pool = gameState.resources?.[ME];
  const canAfford = !pool || ((pool.ore ?? 0) >= MISSILE_COST.ore && (pool.credits ?? 0) >= MISSILE_COST.credits);
  const chosen = worlds.find(w => w.body.id === target) ?? null;
  const chosenGroup = target?.startsWith(GROUP) ? groups.find(g => g.lead.id === target.slice(GROUP.length)) ?? null : null;
  const groupMeet = chosenGroup ? meets[chosenGroup.lead.id] : undefined;
  const n = Math.max(1, Math.min(salvo, stock));
  const damage = MISSILE_DAMAGE * n;
  const kills = chosen ? chosen.ships.filter(s => (s.hp ?? s.hpMax ?? 1) <= damage) : [];
  const myKills = kills.filter(s => s.ownedBy === ME).length;
  const groupKills = chosenGroup ? chosenGroup.members.filter(s => (s.hp ?? s.hpMax ?? 1) <= damage).length : 0;
  const inFlight = gameState.ships.filter(s => s.class === 'missile' && s.ownedBy === ME && s.transit);
  // The open list, narrowed by the search: a world by its name; ships by
  // their empire, their fleet's name or the world they are bound for.
  const needle = query.trim().toLowerCase();
  const hit = (...xs: Array<string | undefined | null>) => !needle || xs.some(x => !!x && x.toLowerCase().includes(needle));
  const shownWorlds = worlds.filter(w => hit(w.body.name));
  const shownOthers = others.filter(g => hit(
    ownerName(g.lead.ownedBy), g.fleet?.name,
    byId.get(g.lead.transit?.currentTransfer?.targetBodyId ?? '')?.name,
  ));
  // Salvos in the air, counted where they were aimed: at an incoming raid
  // (shown on its row), at ships bound elsewhere, or at a world. One
  // count on each fold, never a sentence listing them.
  const incomingHulls = new Set(incoming.flatMap(g => g.members.map(m => m.id)));
  const flyingElsewhere = inFlight.filter(s => s.plannedRendezvous && !incomingHulls.has(s.plannedRendezvous.followShipId)).length;
  const flyingAtWorlds = inFlight.filter(s => !s.plannedRendezvous).length;

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
  const setAutoSalvo = (s: number) => actions && run('auto', () => actions.setMissileDefence(city.id, { salvo: Math.max(1, Math.min(Math.max(1, cap), s)) }));
  const launch = async () => {
    if (!actions) return;
    if (chosenGroup) {
      const ok = await run('launch', () => actions.launchMissilesAtShip(city.id, chosenGroup.lead.id, n));
      if (ok) { setSalvo(1); setTarget(null); }
      return;
    }
    if (!chosen) return;
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
        {/* INCOMING first: every hostile group flying at this world, when a
            salvo would meet it, and a launch on each row. */}
        <div className="wm-silo-col is-incoming">
          <span className="wm-silo-h">{t('worldmenu.silo.incoming')} <b className="wm-silo-hn">{incoming.length}</b></span>
          {incoming.length === 0 ? (
            <span className="wm-silo-note is-body">
              {silo.auto === 'fleets'
                ? t('worldmenu.silo.incomingNoneWatching', { world: body.name })
                : t('worldmenu.silo.incomingNone', { world: body.name })}
            </span>
          ) : (
            <>
              <div className="wm-silo-salvo">
                <span className="wm-silo-h2">{t('worldmenu.silo.salvo')}</span>
                <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.fewer')} disabled={n <= 1} onClick={() => { setSalvo(Math.max(1, n - 1)); setConfirm(false); }}>−</button>
                <span className="wm-silo-num">{stock > 0 ? n : 0}</span>
                <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.more')} disabled={n >= stock} onClick={() => { setSalvo(Math.min(stock, n + 1)); setConfirm(false); }}>+</button>
                <span className="wm-silo-note">{t('worldmenu.silo.ofReady', { n: stock })}</span>
              </div>
              <div className="wm-silo-inc">
                {incoming.map(g => {
                  const tr = g.lead.transit?.currentTransfer;
                  const lands = tr ? Math.max(0, Math.ceil(tr.arriveTick - tick)) : null;
                  const m = meets[g.lead.id];
                  const ids = new Set(g.members.map(s => s.id));
                  const sent = inFlight.filter(s => s.plannedRendezvous && ids.has(s.plannedRendezvous.followShipId));
                  const sentN = sent.reduce((k, s) => k + (s.missileCount ?? 1), 0);
                  const sentMeet = sent.length ? Math.max(0, Math.ceil(Math.min(...sent.map(s => s.plannedRendezvous!.meetTick)) - tick)) : null;
                  // OVER-FIRING (Lorne's list, 2026-10-20): what is already on
                  // its way counts. Every missile hits every hull of the group,
                  // so a hull dies once the damage on it reaches its hp.
                  const hpOf = (sh: Ship) => sh.hp ?? sh.hpMax ?? 1;
                  const sentKills = g.members.filter(sh => hpOf(sh) <= MISSILE_DAMAGE * sentN).length;
                  const dies = g.members.filter(sh => hpOf(sh) <= MISSILE_DAMAGE * sentN + damage).length;
                  const enoughSent = sentN > 0 && sentKills === g.members.length;
                  const own = ownHits[g.lead.id];
                  const hitsOwn = !!own && own.n > 0;
                  const key = `i${g.lead.id}`;
                  const asking = overConfirm === key;
                  const fire = () => {
                    if (!actions) return;
                    if ((enoughSent || hitsOwn) && !asking) { setOverConfirm(key); return; }
                    setOverConfirm(null);
                    void run(key, () => actions.launchMissilesAtShip(city.id, g.lead.id, n));
                  };
                  return (
                    <div key={g.lead.id} className={`wm-silo-irow${m === null ? ' is-out' : ''}`}>
                      <span className="wm-silo-tname">{g.fleet?.name ?? ownerName(g.lead.ownedBy)}</span>
                      <b className="wm-silo-ihulls">{tn('worldmenu.silo.shipsThere', g.members.length)}</b>
                      <span className="wm-silo-tmeta is-wide">
                        {lands != null && <>{t('worldmenu.silo.landsIn', { n: lands })} · </>}
                        {m != null ? t('worldmenu.silo.meetIn', { n: m }) : m === null ? t('worldmenu.silo.cantCatch') : '…'}
                      </span>
                      {sentN > 0 && (
                        <span className="wm-silo-isent is-wide">
                          {t('worldmenu.silo.sentKills', { n: sentN, t: sentMeet ?? 0, k: sentKills, total: g.members.length })}
                        </span>
                      )}
                      {m != null && stock > 0 && !enoughSent && (
                        <span className="wm-silo-ikill is-wide">
                          {sentN > 0
                            ? t('worldmenu.silo.rowKillsMore', { n, k: dies, total: g.members.length })
                            : t('worldmenu.silo.rowKills', { dmg: damage, k: dies, total: g.members.length })}
                        </span>
                      )}
                      {m != null && hitsOwn && (
                        <span className="wm-silo-iown is-wide">
                          {own!.world
                            ? tn('worldmenu.silo.hitsOwnAt', own!.n, { world: own!.world })
                            : tn('worldmenu.silo.hitsOwn', own!.n)}
                        </span>
                      )}
                      <button type="button" className={`wm-silo-btn is-fire${asking ? ' is-confirm' : ''}`}
                        disabled={busy !== null || stock === 0 || m == null}
                        onBlur={() => { if (asking) setOverConfirm(null); }}
                        onClick={fire}>
                        {busy === key ? '…'
                          : asking ? t(hitsOwn ? 'worldmenu.silo.confirmOwn' : 'worldmenu.silo.confirmEnough', { n })
                            : t('worldmenu.silo.fire', { n: stock > 0 ? n : 0 })}
                      </button>
                    </div>
                  );
                })}
              </div>
              <span className="wm-silo-note">{t('worldmenu.silo.previewNear')}</span>
            </>
          )}

          {/* Everything else a salvo can reach, as TWO short lists, never
              one long one (Lorne, 2026-10-20: combining ship intercepts
              and worlds "is going to be a long ass list"). One open at a
              time; a row is the pick. */}
          <div className="wm-silo-folds" role="group">
            {(['ships', 'worlds'] as const).map(f => (
              <button key={f} type="button" className={`wm-silo-more${fold === f ? ' is-on' : ''}`} aria-expanded={fold === f}
                onClick={() => { setFold(o => (o === f ? null : f)); setTarget(null); setConfirm(false); setQuery(''); }}>
                {t(f === 'ships' ? 'worldmenu.silo.foldShips' : 'worldmenu.silo.foldWorlds')}
                <b>{f === 'ships' ? others.length : worlds.length}</b>
                {(f === 'ships' ? flyingElsewhere : flyingAtWorlds) > 0 && (
                  <em className="wm-silo-fly">{t('worldmenu.silo.nInFlight', { n: f === 'ships' ? flyingElsewhere : flyingAtWorlds })}</em>
                )}
                <span aria-hidden>{fold === f ? '▴' : '▾'}</span>
              </button>
            ))}
          </div>
          {fold && (
            <>
              <input type="search" className="wm-silo-search" value={query}
                placeholder={t(fold === 'ships' ? 'worldmenu.silo.searchShips' : 'worldmenu.silo.searchWorlds')}
                aria-label={t(fold === 'ships' ? 'worldmenu.silo.searchShips' : 'worldmenu.silo.searchWorlds')}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
              <div className="wm-silo-list" role="listbox"
                aria-label={t(fold === 'ships' ? 'worldmenu.silo.foldShips' : 'worldmenu.silo.foldWorlds')}>
                {fold === 'worlds' && worlds.length === 0 && <span className="wm-silo-note">{t('worldmenu.silo.noWorlds')}</span>}
                {fold === 'worlds' && worlds.length > 0 && shownWorlds.length === 0 && <span className="wm-silo-note">{t('worldmenu.silo.noMatch', { q: query.trim() })}</span>}
                {fold === 'ships' && others.length === 0 && <span className="wm-silo-note">{t('worldmenu.silo.noShipsElsewhere')}</span>}
                {fold === 'ships' && others.length > 0 && shownOthers.length === 0 && <span className="wm-silo-note">{t('worldmenu.silo.noMatch', { q: query.trim() })}</span>}
                {fold === 'worlds' && shownWorlds.map(w => (
                  <button key={w.body.id} type="button" role="option" aria-selected={w.body.id === target}
                    className={`wm-silo-opt${w.body.id === target ? ' is-on' : ''}`}
                    onClick={() => { setTarget(w.body.id); setConfirm(false); }}>
                    <span className="wm-silo-tname">{w.body.name}</span>
                    <span className="wm-silo-tmeta">{eta[w.body.id] != null ? t('worldmenu.silo.eta', { n: eta[w.body.id] }) : '…'}</span>
                    <span className="wm-silo-tmeta is-wide">
                      {tn('worldmenu.silo.shipsThere', w.total)}
                      {w.hostile ? <b className="is-hostile"> · {tn('worldmenu.silo.hostile', w.hostile)}</b> : null}
                      {w.mine ? <b className="is-mine"> · {tn('worldmenu.silo.yours', w.mine)}</b> : null}
                    </span>
                  </button>
                ))}
                {fold === 'ships' && shownOthers.map(g => {
                  const key = `${GROUP}${g.lead.id}`;
                  const tr = g.lead.transit?.currentTransfer;
                  const hostile = !atPeace(ME, g.lead.ownedBy);
                  const m = meets[g.lead.id];
                  return (
                    <button key={key} type="button" role="option" aria-selected={key === target}
                      className={`wm-silo-opt${key === target ? ' is-on' : ''}${m === null ? ' is-out' : ''}`}
                      onClick={() => { setTarget(key); setConfirm(false); }}>
                      <span className="wm-silo-tname">{g.fleet?.name ?? ownerName(g.lead.ownedBy)}</span>
                      <span className="wm-silo-tmeta">{m != null ? t('worldmenu.silo.meetIn', { n: m }) : m === null ? t('worldmenu.silo.cantCatch') : '…'}</span>
                      <span className="wm-silo-tmeta is-wide">
                        {hostile ? <b className="is-hostile">{tn('worldmenu.silo.shipsThere', g.members.length)}</b> : tn('worldmenu.silo.shipsThere', g.members.length)}
                        {tr ? ` ${t('worldmenu.silo.bound', { world: byId.get(tr.targetBodyId)?.name ?? '?', n: Math.max(0, Math.ceil(tr.arriveTick - tick)) })}` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
              {incoming.length === 0 && (
                <div className="wm-silo-salvo">
                  <span className="wm-silo-h2">{t('worldmenu.silo.salvo')}</span>
                  <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.fewer')} disabled={n <= 1} onClick={() => { setSalvo(Math.max(1, n - 1)); setConfirm(false); }}>−</button>
                  <span className="wm-silo-num">{stock > 0 ? n : 0}</span>
                  <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.more')} disabled={n >= stock} onClick={() => { setSalvo(Math.min(stock, n + 1)); setConfirm(false); }}>+</button>
                  <span className="wm-silo-note">{t('worldmenu.silo.ofReady', { n: stock })}</span>
                </div>
              )}
              {chosenGroup && stock > 0 && (
                <div className="wm-silo-preview is-warn">
                  {groupMeet === null ? <span className="is-strong">{t('worldmenu.silo.previewCantCatch')}</span> : (
                    <>
                      <span className="is-strong">{t('worldmenu.silo.previewIntercept', { dmg: damage, r: MISSILE_BLAST_RADIUS, n: groupMeet ?? '…' })}</span>
                      <span>{t('worldmenu.silo.previewGroupKills', { n: groupKills, total: chosenGroup.members.length })}</span>
                      <span className="is-mine">{t('worldmenu.silo.previewNear')}</span>
                    </>
                  )}
                </div>
              )}
              {chosen && stock > 0 && (
                <div className={`wm-silo-preview${chosen.mine > 0 ? ' is-warn' : ''}`}>
                  <span className="is-strong">{t('worldmenu.silo.previewDamage', { dmg: damage, world: chosen.body.name })}</span>
                  <span>{t('worldmenu.silo.previewKills', { n: kills.length, total: chosen.total })}</span>
                  {chosen.mine > 0 && <span className="is-mine">{t('worldmenu.silo.previewMine', { n: chosen.mine, k: myKills })}</span>}
                </div>
              )}
              <div className="wm-silo-launchrow">
                <button type="button" className={`wm-silo-btn is-fire${confirm ? ' is-confirm' : ''}`}
                  disabled={busy !== null || (!chosen && !chosenGroup) || stock === 0 || (!!chosenGroup && groupMeet == null)} onClick={launch}>
                  {busy === 'launch' ? '…' : confirm ? t('worldmenu.silo.confirmFire', { n }) : t('worldmenu.silo.fire', { n: stock > 0 ? n : 0 })}
                </button>
                {confirm && <button type="button" className="wm-silo-btn" onClick={() => setConfirm(false)}>{t('worldmenu.silo.back')}</button>}
              </div>
            </>
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
          {silo.auto === 'fleets' && (
            <div className="wm-silo-salvo">
              <span className="wm-silo-h2">{t('worldmenu.silo.autoSalvo')}</span>
              <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.fewer')} disabled={busy !== null || silo.salvo <= 1} onClick={() => setAutoSalvo(silo.salvo - 1)}>−</button>
              <span className="wm-silo-num">{silo.salvo}</span>
              <button type="button" className="wm-silo-step" aria-label={t('worldmenu.silo.more')} disabled={busy !== null || silo.salvo >= cap} onClick={() => setAutoSalvo(silo.salvo + 1)}>+</button>
            </div>
          )}
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
      </div>
    </section>
  );
};

export default WmSilo;
