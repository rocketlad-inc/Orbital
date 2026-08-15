// ============================================================
// RouteComposer — building a multi-stop run (DESIGN-trade-v2 §3).
//
// The scale problem, stated: clicking bodies on the map works between
// moons and breaks across the system — at a zoom showing Ceres and Luna
// together, Luna sits on top of Earth, and everything is orbiting while
// you choose. So THE ROUTE IS A LIST and the map is a view of it.
// Selection drives the camera, never the other way round.
//
// Four questions in the order a player asks them:
//   1. where does it go      the stop strip
//   2. what happens there    pick up / drop off (+ per-resource detail)
//   3. how long does it run  the loop rule
//   4. who flies it          carriers and guards
//
// The hold gauge under the strip is the part that makes multi-stop
// click: it simulates the run as you edit, using the SERVER's
// projection endpoint — which shares routeMath.js with the tick, so the
// gauge cannot quietly disagree with what actually gets loaded.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Body, GameState, Ship } from '../types';
import type { RouteProjection, RouteStopInput } from './MultiplayerActionsContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { PlanetIcon } from '../components/PlanetIcon';
import {
  beginRoutePick, endRoutePick, requestRouteFit, setClusterHandler,
} from '../game/routePick/store';
import './RouteComposer.css';

const MAX_STOPS = 6;

export interface RouteComposerProps {
  gameState: GameState;
  /** Editing an existing route's itinerary rather than laying a new one. */
  routeId?: string;
  initialName?: string | null;
  initialStops?: RouteStopInput[];
  /** Pre-selected carrier — set when the composer is opened from a
   *  freighter's own panel ("+ Multi-stop run"), so the ship you were
   *  looking at is already flying it. */
  initialCarrierId?: string;
  // NOTE: there were two map-picking props here (onRequestMapPick and
  // mapPickedBodyId) that NO caller ever passed. Dead wiring is worse
  // than no wiring: the "Pick on map" button was gated on one of them,
  // so the feature looked implemented, read as implemented, and did
  // nothing. Picking now goes through game/routePick/store, which the
  // map reads directly.
  onClose: () => void;
  onSaved?: () => void;
}

/** Only your own settlements can be stops on a domestic run — the same
 *  rule the server re-checks. Dropoffs additionally need a terraformed
 *  world (the loading dock), which is why they are listed separately. */
function eligibleBodies(gameState: GameState) {
  const mine = new Set(
    gameState.settlements.filter(s => s.ownedBy === 'player').map(s => s.bodyId),
  );
  const pickup: Body[] = [];
  const dropoff: Body[] = [];
  for (const b of gameState.bodies) {
    if (!mine.has(b.id)) continue;
    if (b.id === 'sol') continue;              // the Dyson line has its own path
    pickup.push(b);
    if (b.terraformedAtTick != null) dropoff.push(b);
  }
  return { pickup, dropoff };
}

/** Group candidate stops by what they orbit. This is the scale answer:
 *  "which Jupiter moon" becomes one keystroke in a grouped list instead
 *  of a zoom hunt on the map. */
function groupByParent(bodies: Body[], all: Body[]) {
  const byId = new Map(all.map(b => [b.id, b]));
  const groups = new Map<string, Body[]>();
  for (const b of bodies) {
    const parent = b.parent ? byId.get(b.parent) : null;
    const key = parent ? parent.name : 'Sol · direct orbit';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export const RouteComposer: React.FC<RouteComposerProps> = ({
  gameState, routeId, initialName, initialStops, initialCarrierId,
  onClose, onSaved,
}) => {
  // The composer only ever mounts inside the MP shell, but the hook
  // is typed nullable for SP callers — assert once here rather than
  // threading optional chaining through every handler.
  const mp = useMultiplayerActions()!;
  const [name, setName] = useState(initialName ?? '');
  const [stops, setStops] = useState<RouteStopInput[]>(initialStops ?? []);
  const [loopMode, setLoopMode] = useState<'forever' | 'count'>('forever');
  const [loopCount, setLoopCount] = useState(5);
  const [carriers, setCarriers] = useState<string[]>(initialCarrierId ? [initialCarrierId] : []);
  const [guards, setGuards] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  // Map-pick mode. Distinct from `picking`, which is the LIST picker —
  // both add a stop, and having both is the point: the list is faster
  // when you know the name, the map is faster when you know the place.
  const [mapPicking, setMapPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [projection, setProjection] = useState<RouteProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<number | null>(null);

  // The projection endpoint echoes the SERVER's body ids
  // ("<gameId>:saturn") while the client stores them stripped, so a
  // naive lookup missed and the gauge printed raw ids under every bar.
  const bodyOf = useCallback((id: string) => {
    const bare = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id;
    return gameState.bodies.find(b => b.id === id)
        ?? gameState.bodies.find(b => b.id === bare);
  }, [gameState.bodies]);
  const bodyName = useCallback(
    (id: string) => bodyOf(id)?.name ?? id,
    [bodyOf],
  );
  const { pickup, dropoff } = useMemo(() => eligibleBodies(gameState), [gameState]);
  const dropoffIds = useMemo(() => new Set(dropoff.map(b => b.id)), [dropoff]);
  // WHAT IS WAITING THERE, and whether the world can take a delivery.
  // Picking stops blind meant opening the map to check every candidate;
  // a run is chosen on exactly two facts — how much is piled up, and
  // whether cargo can land — so both belong in the row you pick from.
  const stockAt = useCallback((bodyId: string) => {
    let ore = 0, credits = 0, science = 0;
    for (const st of gameState.settlements) {
      if (st.bodyId !== bodyId || st.ownedBy !== 'player') continue;
      ore += st.stockpile?.ore ?? 0;
      credits += st.stockpile?.credits ?? 0;
      science += st.stockpile?.science ?? 0;
    }
    return { ore, credits, science, total: ore + credits + science };
  }, [gameState.settlements]);

  const carrierCap = gameState.carrierCap ?? 1;
  // ONE JOB PER HULL is a server rule, so offering an employed ship here
  // is offering a move that will be refused — the same "enabled button
  // for an illegal action" trap, and it surfaced as a raw constraint
  // error rather than a message. Employed hulls are simply absent, and
  // the row below says how many are out working.
  const employed = useMemo(() => {
    const set = new Set<string>();
    for (const r of gameState.tradeRoutes ?? []) {
      for (const c of r.ships ?? []) set.add(c.shipId);
    }
    // The ship this composer was opened from is already ours to assign.
    if (initialCarrierId) set.delete(initialCarrierId);
    return set;
  }, [gameState.tradeRoutes, initialCarrierId]);
  const allFreighters = useMemo(
    () => gameState.ships.filter(s => s.ownedBy === 'player' && s.class === 'freighter'),
    [gameState.ships],
  );
  const allWarships = useMemo(
    () => gameState.ships.filter(s => s.ownedBy === 'player'
      && ['corvette', 'frigate', 'destroyer'].includes(s.class)),
    [gameState.ships],
  );
  const myFreighters = useMemo(
    () => allFreighters.filter(s => !employed.has(s.id)), [allFreighters, employed]);
  const myWarships = useMemo(
    () => allWarships.filter(s => !employed.has(s.id)), [allWarships, employed]);
  const busyFreighters = allFreighters.length - myFreighters.length;
  const busyWarships = allWarships.length - myWarships.length;

  const addStop = useCallback((bodyId: string) => {
    setStops(prev => {
      if (prev.length >= MAX_STOPS) return prev;
      // A stop that repeats the previous body is a zero-length leg —
      // the server rejects it, so don't let the strip build one.
      if (prev.length > 0 && prev[prev.length - 1].bodyId === bodyId) return prev;
      // Default: the last stop delivers, everything before collects.
      // That IS the milk run, so a fresh route needs no configuring.
      const action: 'pickup' | 'dropoff' = dropoffIds.has(bodyId) && prev.length > 0
        ? 'dropoff' : 'pickup';
      return [...prev, { bodyId, action, takeMetal: true, takeGold: true, takeScience: true }];
    });
    setSearch('');
  }, [dropoffIds]);

  // DRIVE THE MAP. The eligible set is re-published whenever the stop
  // list changes so the rings follow the circuit as it is built, and
  // the request is torn down on unmount — a composer closed mid-pick
  // must not leave the map dimmed with no way to escape it.
  useEffect(() => {
    if (!mapPicking) { endRoutePick(); return; }
    beginRoutePick({
      eligibleBodyIds: new Set(pickup.map(b => b.id)),
      chosenBodyIds: new Set(stops.map(st => st.bodyId)),
      onPick: (id) => addStop(id),
      onCancel: () => setMapPicking(false),
    });
  }, [mapPicking, pickup, stops, addStop]);
  useEffect(() => () => { endRoutePick(); }, []);

  // Which of these? Posted by the map when a click lands on several
  // eligible worlds at once — resolved here rather than in a popover
  // over the map, so the answer appears where the player is already
  // reading the circuit they are building.
  const [cluster, setCluster] = useState<string[] | null>(null);
  useEffect(() => {
    if (!mapPicking) { setCluster(null); return; }
    setClusterHandler(ids => setCluster(ids));
    return () => setClusterHandler(null);
  }, [mapPicking]);

  // Esc leaves pick mode. Without it the only way out is finding the
  // button again, which on a dimmed map is exactly when you can't.
  useEffect(() => {
    if (!mapPicking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setMapPicking(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mapPicking]);

  // FRAME THE CIRCUIT. Re-fit as stops are added so a run that reaches
  // from Mercury to Titan stays entirely on screen — otherwise picking
  // the far stop scrolls the near ones out of view and the player
  // loses the shape of what they are building.
  useEffect(() => {
    if (!mapPicking || stops.length === 0) return;
    requestRouteFit(stops.map(st => st.bodyId));
  }, [mapPicking, stops]);

  const move = (i: number, delta: number) => {
    setStops(prev => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const removeStop = (i: number) => setStops(prev => prev.filter((_, k) => k !== i));
  const setAction = (i: number, action: 'pickup' | 'dropoff') =>
    setStops(prev => prev.map((s, k) => (k === i ? { ...s, action } : s)));
  const toggleTake = (i: number, key: 'takeMetal' | 'takeGold' | 'takeScience') =>
    setStops(prev => prev.map((s, k) => (k === i ? { ...s, [key]: !(s[key] !== false) } : s)));

  // Re-project whenever the itinerary changes. Debounced because every
  // keystroke of reordering would otherwise be a round trip.
  const valid = stops.length >= 2
    && stops.some(s => s.action === 'pickup')
    && stops.some(s => s.action === 'dropoff');
  useEffect(() => {
    if (!valid) { setProjection(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await mp.projectRoute(stops, carriers[0]);
      if (!cancelled) setProjection(res.ok ? res.projection ?? null : null);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [stops, carriers, valid, mp]);

  const save = async () => {
    setErr(null);
    setBusy(true);
    const res = routeId
      ? await mp.updateRouteStops(routeId, stops, name.trim() || null)
      : await mp.createRouteFull({
        name: name.trim() || null,
        stops,
        loopMode,
        loopCount: loopMode === 'count' ? loopCount : undefined,
        carrierShipIds: carriers,
        guardShipIds: guards,
      });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? 'The server turned that down.'); return; }
    onSaved?.();
    onClose();
  };

  const searchable = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? pickup.filter(b => b.name.toLowerCase().includes(q)) : pickup;
    return groupByParent(list, gameState.bodies);
  }, [search, pickup, gameState.bodies]);

  const cap = projection?.hold_cap ?? 500;
  const disabledReason = !valid
    ? (stops.length < 2 ? 'Add at least two stops.'
      : !stops.some(s => s.action === 'pickup') ? 'Nothing is picked up anywhere on this run.'
        : 'Nothing is dropped off anywhere on this run.')
    : carriers.length === 0 && !routeId ? 'Name a freighter to run it.'
      : null;

  return (
    <div className="rc-backdrop" role="dialog" aria-label="Route composer">
      <div className="rc">
        <div className="rc-head">
          <span className="rc-title">{routeId ? 'Edit run' : 'New route'}</span>
          <input
            className="rc-name"
            value={name}
            placeholder="Name it (optional) — e.g. Ceres Milk Run"
            maxLength={60}
            onChange={e => setName(e.target.value)}
          />
          <button className="rc-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="rc-section-label">Stops — in visiting order</div>
        <div className="rc-strip">
          {stops.length === 0 && (
            <div className="rc-empty">
              No stops yet. Add the places this run visits — it collects at each
              stop and drops everything at the last one.
            </div>
          )}
          {stops.map((s, i) => (
            <div key={`${s.bodyId}-${i}`} className={`rc-stop${s.action === 'dropoff' ? ' is-drop' : ''}`}>
              <div className="rc-num">{i + 1}</div>
              <div className="rc-stop-main">
                <div className="rc-stop-name">
                  {bodyOf(s.bodyId) && (
                    <PlanetIcon
                      body={bodyOf(s.bodyId)!}
                      size={16}
                      currentTick={gameState.currentTick}
                      className="rc-planet"
                    />
                  )}
                  {bodyName(s.bodyId)}
                </div>
                <button
                  type="button"
                  className="rc-sub"
                  onClick={() => setDetailFor(detailFor === i ? null : i)}
                  title="Choose which resources this stop picks up"
                >
                  {s.action === 'dropoff'
                    ? 'drop it all'
                    : [s.takeMetal !== false && 'metal', s.takeGold !== false && 'credits',
                      s.takeScience !== false && 'science'].filter(Boolean).join(' · ') || 'nothing selected'}
                </button>
                {detailFor === i && s.action === 'pickup' && (
                  <div className="rc-detail">
                    {([['takeMetal', 'metal'], ['takeGold', 'credits'], ['takeScience', 'science']] as const)
                      .map(([key, label]) => (
                        <label key={key} className="rc-check">
                          <input
                            type="checkbox"
                            checked={s[key] !== false}
                            onChange={() => toggleTake(i, key)}
                          />
                          {label}
                        </label>
                      ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`rc-pill${s.action === 'dropoff' ? ' is-drop' : ''}`}
                onClick={() => setAction(i, s.action === 'pickup' ? 'dropoff' : 'pickup')}
                disabled={s.action === 'pickup' && !dropoffIds.has(s.bodyId)}
                title={s.action === 'pickup' && !dropoffIds.has(s.bodyId)
                  ? 'Cargo can only be dropped at a terraformed world you live on'
                  : 'Switch between picking up and dropping off here'}
              >
                {s.action === 'dropoff' ? 'Drop off' : 'Pick up'}
              </button>
              <div className="rc-reorder">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move earlier">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === stops.length - 1} aria-label="Move later">↓</button>
                <button type="button" onClick={() => removeStop(i)} aria-label="Remove stop">✕</button>
              </div>
            </div>
          ))}
          {stops.length >= 2 && <div className="rc-loopback">↻ then back to stop 1</div>}
        </div>

        {stops.length < MAX_STOPS && (
          <div className="rc-add">
            <button type="button" className="rc-addbtn" onClick={() => setPicking(p => !p)}>
              + Add stop
            </button>
            {/* PICK ON MAP. This button existed but was gated on a prop
                neither mount ever passed, so map picking was dead code
                and the list was the only way in. It now drives the
                route-pick store directly, which both the canvas and the
                renderer already read. */}
            <button
              type="button"
              className={`rc-addbtn is-map${mapPicking ? ' is-on' : ''}`}
              onClick={() => setMapPicking(v => !v)}
              title="Click worlds on the map to add them. Worlds you can't ship from are dimmed."
            >
              {mapPicking ? 'Picking… (Esc)' : 'Pick on map'}
            </button>
            {cluster && cluster.length > 1 && (
              <div className="rc-cluster">
                <div className="rc-cluster-q">Several worlds there — which one?</div>
                <div className="rc-cluster-opts">
                  {cluster.map(id => {
                    const b = gameState.bodies.find(x => x.id === id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className="rc-cluster-opt"
                        onClick={() => { addStop(id); setCluster(null); }}
                      >
                        {b?.name ?? id}
                      </button>
                    );
                  })}
                  <button type="button" className="rc-cluster-opt is-cancel"
                          onClick={() => setCluster(null)}>Cancel</button>
                </div>
              </div>
            )}
            {picking && (
              <div className="rc-picker">
                <input
                  className="rc-search"
                  autoFocus
                  value={search}
                  placeholder="Search your worlds…"
                  onChange={e => setSearch(e.target.value)}
                />
                <div className="rc-picker-hint">
                  Cargo can only be dropped at a <b>terraformed</b> world you live on.
                  Raw worlds can still be collected from.
                </div>
                <div className="rc-picker-list">
                  {searchable.length === 0 && <div className="rc-empty">Nothing matches.</div>}
                  {searchable.map(([group, items]) => (
                    <div key={group}>
                      <div className="rc-group">{group}</div>
                      {items.map(b => (
                        <button
                          key={b.id}
                          type="button"
                          className="rc-pick"
                          onClick={() => { addStop(b.id); setPicking(false); }}
                        >
                          <PlanetIcon
                            body={b}
                            size={18}
                            currentTick={gameState.currentTick}
                            className="rc-planet"
                          />
                          <span className="rc-pick-name">{b.name}</span>
                          <span className="rc-pick-stock">
                            {(() => {
                              const st = stockAt(b.id);
                              if (st.total < 1) return <span className="rc-pick-empty">nothing waiting</span>;
                              return [
                                st.ore >= 1 ? `${Math.round(st.ore)}M` : null,
                                st.credits >= 1 ? `${Math.round(st.credits)}C` : null,
                                st.science >= 1 ? `${Math.round(st.science)}S` : null,
                              ].filter(Boolean).join(' · ');
                            })()}
                          </span>
                          <span className={`rc-pick-meta${dropoffIds.has(b.id) ? ' is-dock' : ''}`}>
                            {dropoffIds.has(b.id) ? 'terraformed · can drop off' : 'raw · pick up only'}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {projection && (
          <>
            <div className="rc-section-label">The run, as it will actually go</div>
            <HoldGauge
              projection={projection}
              cap={cap}
              bodyName={bodyName}
              bodyOf={bodyOf}
              currentTick={gameState.currentTick}
            />
          </>
        )}

        {!routeId && (
          <>
            <div className="rc-section-label">When to stop looping</div>
            <div className="rc-radios">
              <button type="button" className={`rc-radio${loopMode === 'forever' ? ' on' : ''}`}
                onClick={() => setLoopMode('forever')}>Repeat forever</button>
              <button type="button" className={`rc-radio${loopMode === 'count' ? ' on' : ''}`}
                onClick={() => setLoopMode('count')}>Repeat a set number of times</button>
              {loopMode === 'count' && (
                <input
                  className="rc-count" type="number" min={1} max={999} value={loopCount}
                  onChange={e => setLoopCount(Math.max(1, Math.min(999, Number(e.target.value) || 1)))}
                />
              )}
            </div>

            <div className="rc-section-label">Ships</div>
            <ShipRow
              label="Runs it"
              hint={carriers.length >= carrierCap
                ? `At your research a route can hold ${carrierCap} freighter${carrierCap === 1 ? '' : 's'}.`
                : busyFreighters > 0
                  ? `${busyFreighters} more ${busyFreighters === 1 ? 'freighter is' : 'freighters are'} already on a route.`
                  : undefined}
              options={myFreighters}
              chosen={carriers}
              max={carrierCap}
              onToggle={id => setCarriers(prev =>
                prev.includes(id) ? prev.filter(x => x !== id)
                  : prev.length < carrierCap ? [...prev, id] : prev)}
            />
            <ShipRow
              label="Guards"
              hint={`Guards fly the run with the freighter and hold fire unless something attacks it.${
                busyWarships > 0 ? ` ${busyWarships} more already on a route.` : ''}`}
              options={myWarships}
              chosen={guards}
              onToggle={id => setGuards(prev =>
                prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
            />
          </>
        )}

        {err && <div className="rc-err">{err}</div>}

        <div className="rc-foot">
          {projection && (
            <div className="rc-readout">
              <span>loop <b>≈{projection.loop_ticks} ticks</b></span>
              <span>peak hold <b>{Math.round(projection.peak_per_resource)} / {cap}</b></span>
              <span>delivers <b>{Math.round(
                projection.delivered.metal + projection.delivered.gold + projection.delivered.science,
              )} / loop</b></span>
            </div>
          )}
          <div className="rc-actions">
            <button type="button" className="rc-btn" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="rc-btn is-primary"
              disabled={busy || !!disabledReason}
              title={disabledReason ?? undefined}
              onClick={save}
            >
              {busy ? 'Saving…' : routeId ? 'Save run' : 'Create route'}
            </button>
          </div>
        </div>
        {disabledReason && <div className="rc-why">{disabledReason}</div>}
      </div>
    </div>
  );
};

/** The hold gauge: one bar per stop against a "full" line. Overfill is
 *  the thing it exists to show — a bar at the ceiling means the next
 *  pickup is wasted, and you learn that before launching. */
const HoldGauge: React.FC<{
  projection: RouteProjection;
  cap: number;
  bodyName: (id: string) => string;
  bodyOf: (id: string) => Body | undefined;
  currentTick: number;
}> = ({ projection, cap, bodyName, bodyOf, currentTick }) => {
  const over = projection.peak_per_resource >= cap;
  // SCALE TO THE RUN, not to the theoretical ceiling. The first version
  // divided by cap*3 (three resources at 500 each), so a real 50-unit
  // milk run drew 1px of bar and the chart looked broken — which is
  // exactly how it was reported. The axis now tops out at the biggest
  // load the run actually reaches, so a small run is readable and a
  // near-full one still visibly crowds the ceiling.
  const peakTotal = Math.max(1, ...projection.stops.map(s => s.aboard_total));
  const axisMax = over ? Math.max(peakTotal, cap) : peakTotal;
  return (
    <div className="rc-gauge">
      <div className="rc-gauge-bars">
        {projection.stops.map(s => {
          const pct = Math.min(100, (s.aboard_total / axisMax) * 100);
          const full = s.aboard_after.metal >= cap || s.aboard_after.gold >= cap
            || s.aboard_after.science >= cap;
          const b = bodyOf(s.body_id);
          return (
            <div key={s.sequence} className="rc-gauge-col">
              <div className="rc-gauge-track">
                <div
                  className={`rc-gauge-bar${full ? ' is-over' : ''}`}
                  style={{ height: `${s.aboard_total > 0 ? Math.max(4, pct) : 0}%` }}
                />
              </div>
              <div className="rc-gauge-lbl">
                {s.sequence + 1} · {s.action === 'dropoff' ? 'empty' : Math.round(s.aboard_total)}
              </div>
              <div className="rc-gauge-body">
                {b && <PlanetIcon body={b} size={14} currentTick={currentTick} className="rc-planet" />}
                {bodyName(s.body_id)}
              </div>
            </div>
          );
        })}
      </div>
      {over && (
        <div className="rc-gauge-warn">
          The hold fills up before the end of the run — later pickups will come
          back light. Drop something off sooner, or take fewer resources.
        </div>
      )}
    </div>
  );
};

const ShipRow: React.FC<{
  label: string;
  hint?: string;
  options: Ship[];
  chosen: string[];
  max?: number;
  onToggle: (id: string) => void;
}> = ({ label, hint, options, chosen, max, onToggle }) => (
  <div className="rc-shiprow">
    <div className="rc-shiprow-label">{label}</div>
    <div className="rc-shiprow-list">
      {options.length === 0 && <span className="rc-empty">None available.</span>}
      {options.map(s => {
        const on = chosen.includes(s.id);
        const blocked = !on && max != null && chosen.length >= max;
        return (
          <button
            key={s.id}
            type="button"
            className={`rc-ship${on ? ' on' : ''}`}
            disabled={blocked}
            title={blocked ? hint : undefined}
            onClick={() => onToggle(s.id)}
          >
            {s.name}
          </button>
        );
      })}
    </div>
    {hint && <div className="rc-hint">{hint}</div>}
  </div>
);

export default RouteComposer;
