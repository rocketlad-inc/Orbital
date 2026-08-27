// ============================================================
// MegastructureCard — the panel for a construction site, and the flow
// that creates one.
//
// Self-contained and mounted next to MeteoroidCard, for the same
// reason: it reads the selected body from uiState and renders only when
// that body is one of ours to care about, so nothing else in the tree
// has to know megastructures exist.
//
// It covers three states that are really one object at different ages:
//   PLACING   — a colony ship is committed and the map is waiting for a
//               click. This card is the banner and the cancel.
//   BUILDING  — a site exists and wants freight.
//   COMPLETE  — it is a structure now.
// ============================================================

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { humanizeMpError } from './errorMessages';
import {
  MEGASTRUCTURES, MEGASTRUCTURE_KINDS, MegastructureKind,
  progressOf, remainingFor, loadsRemaining, effectSummary, headlineFor,
  MEGA_MAX_HP, MEGA_SEIZE_HP_FRAC, isBreached, isAbandoned,
} from '../game/megastructures';
import {
  StructureIcon, variantsFor, STRUCTURE_VARIANT_NAMES,
} from '../components/StructureIcons';
import type { StructureVariant } from '../components/StructureIcons';
import {
  getPlacement, subscribePlacement, cancelPlacement,
} from '../game/megastructurePlacement';
import { useFeatureGate } from '../hooks/useFeatureGate';
import type { FeatureId } from '../game/researchUnlocks';
import './MegastructureCard.css';
import { RouteComposer } from './RouteComposer';
import type { RouteStopInput } from './MultiplayerActionsContext';
import { buildStageName } from '../render/megastructureArt';

const HOLD = 400;

export const MegastructureCard: React.FC = () => {
  const { gameState, uiState } = useGameContext();
  const mpActions = useMultiplayerActions();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- gate — hook call kept; removing it would drop a subscription
  const gate = useFeatureGate();

  const placement = useSyncExternalStore(subscribePlacement, getPlacement, () => null);

  const body = uiState.selectedBodyId
    ? gameState.bodies.find(b => b.id === uiState.selectedBodyId)
    : undefined;
  const site = body && gameState.megastructures
    ? gameState.megastructures[body.id]
    : undefined;

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Opening the composer pre-seeded with THIS site as the dropoff.
  // The alternative is telling a player looking straight at a
  // half-built gate to go and find it again in a list.
  const [composing, setComposing] = useState<RouteStopInput[] | null>(null);
  // Optimistic pass list. /state is up to a tick behind, so without
  // this a ticked box visibly un-ticks itself a moment later.
  const [pendingPass, setPendingPass] = useState<string[] | null>(null);

  // Escape cancels placement — the same key that closes every other
  // modal here. Without it the only way out is to place something.
  useEffect(() => {
    if (!placement) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPlacement();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placement]);

  const deliver = useCallback((shipId: string) => {
    if (!mpActions || !site) return;
    setBusy(true);
    setError(null);
    mpActions.deliverToSite(site.bodyId, shipId).then((res) => {
      setBusy(false);
      if (!res.ok) setError(humanizeMpError(res.code, res.error, 'transfer'));
    });
  }, [mpActions, site]);

  if (composing) {
    return (
      <RouteComposer
        gameState={gameState}
        initialStops={composing}
        onClose={() => setComposing(null)}
        onSaved={() => setComposing(null)}
      />
    );
  }

  // ---- placement banner -------------------------------------------
  if (placement) {
    const def = MEGASTRUCTURES[placement.kind];
    return (
      <div className="megac megac--banner">
        <div className="megac__banner-row">
          <span className="megac__glyph" style={{ color: def.color }}>{def.glyph}</span>
          <div>
            <div className="megac__title">Placing {def.label}</div>
            <div className="megac__sub">
              Click inside the highlighted ring. The colony ship is spent laying it.
            </div>
          </div>
          <button className="megac__cancel" onClick={cancelPlacement}>Cancel (Esc)</button>
        </div>
      </div>
    );
  }

  if (!site || !body) return null;

  const def = MEGASTRUCTURES[site.kind];
  const pct = progressOf(site);
  const rem = remainingFor(site);
  const loads = loadsRemaining(site, HOLD);
  const complete = site.status === 'complete';
  const mine = body.ownedBy === 'player';
  // Its faction was eliminated. Unowned, still standing, and claimable
  // by the first hull to reach it — a different thing entirely from a
  // rival's structure, and it must not read as one.
  const derelict = isAbandoned(site, body.ownedBy);

  // Ships of ours parked ON the site, which is the only place a manual
  // delivery can happen from.
  const here = gameState.ships.filter(
    s => s.ownedBy === 'player' && !s.transit && s.orbit.parentBodyId === body.id
      && ((s.cargo?.ore ?? 0) > 0 || (s.cargo?.credits ?? 0) > 0),
  );

  return (
    <div className="megac">
      <div className="megac__head">
        <span className="megac__glyph" style={{ color: def.color }}>{def.glyph}</span>
        <div className="megac__headtext">
          <div className="megac__title">{def.label}</div>
          <div className="megac__sub">
            {complete ? 'Operational' : buildStageName(pct)}
            {derelict ? ' · abandoned' : !mine && ' · not yours'}
          </div>
        </div>
      </div>

      <p className="megac__blurb">{effectSummary(site.kind)}</p>

      {/* HULL. Shown to anyone who can see the structure, owner or not —
          how close a thing is to being boardable is the single most
          decision-relevant number on the panel for BOTH sides, and
          hiding it from the attacker would just mean shooting blind
          while the defender watched. Rendered above the construction
          bar because a site at 12 HP is about to change hands whatever
          its build progress says. */}
      {(() => {
        const hp = Math.max(0, Math.round(site.hp));
        const frac = Math.max(0, Math.min(1, hp / MEGA_MAX_HP));
        const breached = isBreached(site);
        // Green while it is a construction problem, amber once the
        // damage is real, red once it is boardable. The red is the same
        // one the Mega Destroyer's charge bar uses: both mean "this is
        // about to be taken away from somebody".
        const tone = breached ? '#ff5e5e' : frac < 0.6 ? '#ffb84d' : '#6ee7b7';
        return (
          <div className="megac__hull">
            <div className="megac__hullhead">
              <span>Hull</span>
              <b style={{ color: tone }}>{hp} / {MEGA_MAX_HP}</b>
            </div>
            <div className="megac__barwrap">
              <div
                className="megac__bar"
                style={{ width: `${(frac * 100).toFixed(1)}%`, background: tone }}
              />
            </div>
            {breached && (
              <div className="megac__hullwarn">
                Breached — boardable by anyone holding the orbit.
              </div>
            )}
          </div>
        );
      })()}

      {!complete && (
        <>
          <div className="megac__barwrap">
            <div
              className="megac__bar"
              style={{ width: `${(pct * 100).toFixed(1)}%`, background: def.color }}
            />
          </div>
          <div className="megac__pct">
            {/* The stage NAME, not just the number. It is the same word
                the map sprite is illustrating, so a player who glanced
                at the structure and came here reads one story rather
                than two. */}
            {buildStageName(pct)} · {(pct * 100).toFixed(1)}%
            {/* Loads, not raw numbers. "18 freighter runs" is the unit a
                player plans in; 7,000 credits is not. */}
            <span className="megac__loads">
              {loads} freighter {loads === 1 ? 'load' : 'loads'} to go
            </span>
          </div>

          <div className="megac__needs">
            <div><span>Metal</span><b>{Math.round(site.accMetal)} / {site.costMetal}</b></div>
            <div><span>Credits</span><b>{Math.round(site.accCredits)} / {site.costCredits}</b></div>
          </div>

          {/* WHO IS ALREADY HAULING TO THIS. A site that says "31 loads
              to go" and nothing else leaves a player unable to tell a
              standing supply line from a dead one — so they lay a second
              route, or worse, assume one exists and never lay a first.
              Routes are matched on having a stop HERE, which is the same
              test the tick uses when it decides where to unload. */}
          {(() => {
            const hauling = (gameState.tradeRoutes ?? []).filter(
              rt => (rt.stops ?? []).some(st => st.bodyId === site.bodyId),
            );
            const crew = hauling.flatMap(rt => (rt.ships ?? [])
              .filter(sh => sh.role === 'carrier')
              .map(sh => ({
                routeId: rt.id,
                name: sh.shipName
                  ?? gameState.ships.find(x => x.id === sh.shipId)?.name
                  ?? 'Freighter',
                status: rt.status,
              })));
            if (crew.length === 0) {
              return (
                <div className="megac__crewnone">
                  Nothing is hauling to this yet.
                </div>
              );
            }
            return (
              <div className="megac__crew">
                <div className="megac__gatehead">
                  {crew.length} freighter{crew.length === 1 ? '' : 's'} on supply
                </div>
                {crew.map((c, i) => (
                  <div key={`${c.routeId}:${i}`} className="megac__crewrow">
                    <span className="megac__crewname">{c.name}</span>
                    {/* Outbound means carrying TO the site; returning means
                        going back for more. Both are a working line, and
                        saying which is the difference between "it is on the
                        way" and "it is coming back round". */}
                    <span className={`megac__crewst is-${c.status}`}>
                      {c.status === 'outbound' ? 'inbound'
                        : c.status === 'returning' ? 'returning for more'
                        : c.status}
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* THE SUPPLY HALF IS OWNER-ONLY. Progress, needs and haulers
              above are intelligence and stay visible to anyone who can
              see the site — knowing a rival's Mega Destroyer is at 88%
              is exactly the thing worth knowing. Pouring your own metal
              into it is not: it finishes THEIR structure, and the card
              was offering it as the primary button on a panel whose own
              subtitle read 'not yours'. */}
          {!mine ? (
            <div className="megac__hint">
              This belongs to somebody else. Take it and the freight
              already in it becomes yours; supply it and you are paying
              for their structure.
            </div>
          ) : (<>
          {/* THE AUTOMATED HALF. Manual delivery is one hold at a time;
              a standing route is how 31 loads actually get made. Seeded
              with a terraformed world of yours as the pickup, because a
              construction run has to load where the pool is on the dock
              and the server refuses anything else. */}
          <button
            className="megac__route"
            onClick={() => {
              const origin = gameState.bodies.find(
                b => b.terraformedAtTick != null
                  && gameState.settlements.some(st => st.bodyId === b.id && st.ownedBy === 'player'),
              );
              setComposing([
                ...(origin ? [{ bodyId: origin.id, action: 'pickup' as const }] : []),
                { bodyId: site.bodyId, action: 'dropoff' as const },
              ]);
            }}
          >
            ⇌ Run a supply route here
          </button>

          {here.length > 0 ? (
            <div className="megac__ships">
              {here.map(s => (
                <button
                  key={s.id}
                  className="megac__deliver"
                  disabled={busy}
                  onClick={() => deliver(s.id)}
                  title={`Unload ${s.name} into the site — it takes only what it still needs`}
                >
                  Deliver from {s.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="megac__hint">
              Park a loaded ship here to unload by hand, or run a trade route to it.
              Still wants {rem.metal} metal and {rem.credits} credits.
            </div>
          )}
          </>)}
        </>
      )}

      {complete && site.kind !== 'warp_gate' && (
        <div className="megac__done" style={{ borderColor: def.color, color: def.color }}>
          Finished on tick {site.completedAtTick}
        </div>
      )}

      {/* GATE WIRING. Only the owner may re-wire, but the partner is
          shown to anyone who can see the gate: a gate is a two-way door
          and knowing where it comes out is exactly the intelligence that
          makes building one a risk. */}
      {complete && site.kind === 'warp_gate' && (() => {
        const partner = site.partnerBodyId
          ? gameState.bodies.find(b => b.id === site.partnerBodyId)
          : undefined;
        // Your OTHER finished gates — the only legal partners.
        const others = Object.values(gameState.megastructures ?? {})
          // The gate already wired to this one is excluded, not merely
          // disabled: "Pair with Earth Gate" sitting under "↔ Earth Gate"
          // reads as an action with an effect, and the only honest thing
          // it could do is nothing.
          .filter(m => m.kind === 'warp_gate'
            && m.status === 'complete'
            && m.bodyId !== site.bodyId
            && m.bodyId !== site.partnerBodyId)
          .map(m => ({ m, body: gameState.bodies.find(b => b.id === m.bodyId) }))
          // YOURS, PLUS ANY PARTNER'S. A construction pact is consent to
          // build together and a gate network is the most literal form
          // of it — so a partner's finished gate is a legal far end. The
          // server has the final say (it re-checks the pact and the far
          // gate's own veto), which is what keeps a stale client from
          // opening a door that is no longer authorised.
          .filter(x => !!x.body
            && (x.body.ownedBy === 'player'
              || (x.body.ownedBy != null
                && (gameState.constructionPartners ?? []).includes(x.body.ownedBy))));

        const setPartner = (id: string | null) => {
          if (!mpActions) return;
          setBusy(true);
          setError(null);
          mpActions.pairGate(site.bodyId, id).then((res) => {
            setBusy(false);
            if (!res.ok) setError(humanizeMpError(res.code, res.error, 'transfer'));
          });
        };

        return (
          <div className="megac__gate">
            <div className="megac__gatehead">Gate link</div>
            {partner ? (
              <div className="megac__linked">
                <span>↔ {partner.name}</span>
                {mine && (
                  <button disabled={busy} onClick={() => setPartner(null)}>Cut link</button>
                )}
              </div>
            ) : (
              <div className="megac__hint">
                Not wired to anything. A gate with no partner is a door that
                opens onto a wall.
              </div>
            )}
            {mine && others.length > 0 && (
              <div className="megac__pairlist">
                {others.map(({ m, body: b }) => (
                  <button
                    key={m.bodyId}
                    disabled={busy}
                    onClick={() => setPartner(m.bodyId)}
                    title={m.partnerBodyId
                      ? 'This gate is already wired elsewhere — pairing here drops that link'
                      : undefined}
                  >
                    Pair with {b!.name}
                    {m.partnerBodyId && ' (re-wires)'}
                  </button>
                ))}
              </div>
            )}
            {mine && others.length === 0 && !partner && (
              <div className="megac__hint">
                Build a second gate to pair this one with.
              </div>
            )}
            <div className="megac__warn">
              {site.foundedByFactionId === null
                ? 'An ancient gate. It belongs to nobody, anyone may use it, '
                  + 'and its link cannot be changed.'
                : 'Anyone can fly through this, including the people you built '
                  + 'it against.'}
            </div>
          </div>
        );
      })()}

      {/* SEIZING SOMEBODY ELSE'S. Only shown on a structure that is not
          yours and has an owner — an ancient gate belongs to nobody and
          taking it would hand one faction the map's only permanent
          crossing. The 30% is stated on the button, not discovered
          afterwards. */}
      {/* A DERELICT. No breach, no boarding party, no contest — its
          empire is gone. Presence is the whole price, so the button
          says exactly that and nothing about force. */}
      {derelict && mpActions && (() => {
        const anyHere = gameState.ships.filter(
          sh => sh.ownedBy === 'player' && !sh.transit
            && sh.orbit?.parentBodyId === site.bodyId,
        ).length;
        return (
          <div className="megac__seize">
            <div className="megac__gatehead">Abandoned</div>
            <div className="megac__hint">
              The faction that built this is gone. The first to put a ship in
              orbit takes it.
            </div>
            {anyHere > 0 ? (
              <button
                className="megac__take"
                disabled={busy}
                onClick={() => {
                  setBusy(true); setError(null);
                  mpActions.claimSite(site.bodyId).then((res) => {
                    setBusy(false);
                    if (!res.ok) setError(humanizeMpError(res.code, res.error, 'transfer'));
                  });
                }}
                title="Nobody is defending it — presence is enough"
              >
                Claim it
              </button>
            ) : (
              <div className="megac__hint">
                Put any ship in orbit here to claim it. It does not have to be armed.
              </div>
            )}
          </div>
        );
      })()}

      {/* TAKING IT. The buttons used to render on every rival site with
          the rule as a footnote, so the common case was a player with no
          fleet anywhere near it clicking Capture and being refused. A
          control that is live only under a condition should SAY the
          condition and stay dark until it holds.

          Mirrors handleSeizeSite: an armed hull of yours parked here,
          and nobody else's. Freighters and colony hulls do not count —
          a hauler at a gate is not an occupying force. Fog of war means
          the rival warship count can be short, so the server still gets
          the last word; this only stops the hopeless click. */}
      {!mine && !derelict && site.foundedByFactionId !== null && mpActions && (() => {
        const armedHere = gameState.ships.filter(sh =>
          sh.orbit?.parentBodyId === site.bodyId
          && sh.class !== 'freighter' && sh.class !== 'colony');
        const myForce = armedHere.filter(sh => sh.ownedBy === 'player');
        const rivalForce = armedHere.filter(sh => sh.ownedBy !== 'player');
        // THREE CONDITIONS, REPORTED ONE AT A TIME. Listing all of them
        // at once reads as a wall; naming the next one that is missing
        // reads as a plan. Ordered the way a player works through them:
        // break it, hold it, clear it.
        const breached = isBreached(site);
        const canTake = breached && myForce.length > 0 && rivalForce.length === 0;
        const why = !breached
          ? `Hull at ${Math.max(0, Math.round(site.hp))}/${MEGA_MAX_HP}. Park warships `
            + `on it to break it below ${Math.round(MEGA_MAX_HP * MEGA_SEIZE_HP_FRAC)} `
            + '— it repairs itself the moment you leave.'
          : myForce.length === 0
            ? 'Breached. Bring an armed ship here to board it. Freighters do not count.'
            : `Contested — ${rivalForce.length} rival warship${rivalForce.length === 1 ? '' : 's'} `
              + 'still here. Clear them off first.';

        return (
        <div className="megac__seize">
          <div className="megac__gatehead">Not yours</div>
          {!canTake && <div className="megac__hint">{why}</div>}
          {canTake && (<>
          <button
            className="megac__take"
            disabled={busy}
            onClick={() => {
              setBusy(true); setError(null);
              mpActions.seizeSite(site.bodyId, 'capture').then((res) => {
                setBusy(false);
                if (!res.ok) setError(humanizeMpError(res.code, res.error, 'transfer'));
              });
            }}
            title="Keep it, and 70% of the freight already poured into it"
          >
            Capture — keep 70% of progress
          </button>
          <button
            className="megac__raze"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Destroy ${def.label}? Nobody gets it.`)) return;
              setBusy(true); setError(null);
              mpActions.seizeSite(site.bodyId, 'destroy').then((res) => {
                setBusy(false);
                if (!res.ok) setError(humanizeMpError(res.code, res.error, 'transfer'));
              });
            }}
          >
            Destroy — deny it to everyone
          </button>
          <div className="megac__hint">
            {myForce.length} armed ship{myForce.length === 1 ? '' : 's'} of yours
            {' '}here and nobody else's.
          </div>
          </>)}
        </div>
        );
      })()}

      {/* THE SINK'S PASS LIST. Owner-only, and the owner is never in it:
          a filter you could accidentally exclude yourself from is a trap
          rather than a setting. */}
      {mine && complete && site.kind === 'gravity_sink' && mpActions && (() => {
        // Everyone else in the game, by NAME. This listed raw faction ids
        // and had no idea what was already stored, so a player could not
        // tell whether they had waved somebody through or were looking at
        // a blank form. Both are now read from state.
        const others = gameState.factions.filter(f => f.id !== 'player');
        const passing = new Set(pendingPass ?? site.passFactionIds);

        const toggle = (fid: string, on: boolean) => {
          const next = new Set(passing);
          if (on) next.add(fid); else next.delete(fid);
          const list = [...next];
          setPendingPass(list);           // optimistic: the tick is 7 minutes away
          setError(null);
          mpActions.setSinkPass(site.bodyId, list).then((res) => {
            if (!res.ok) {
              setPendingPass(null);       // snap back to the server's truth
              setError(humanizeMpError(res.code, res.error, 'transfer'));
            }
          });
        };

        return (
          <div className="megac__gate">
            <div className="megac__gatehead">Who passes</div>
            {others.length === 0 ? (
              <div className="megac__hint">Nobody else is left in this game.</div>
            ) : others.map(f => (
              <label key={f.id} className="megac__passrow">
                <input
                  type="checkbox"
                  checked={passing.has(f.id)}
                  onChange={e => toggle(f.id, e.target.checked)}
                />
                <span className="megac__passdot" style={{ background: f.color }} />
                <span className="megac__passname">{f.name}</span>
                <span className="megac__passst">
                  {passing.has(f.id) ? 'passes' : 'held'}
                </span>
              </label>
            ))}
            <div className="megac__warn">
              You always pass. Anyone unticked is held for{' '}
              {MEGASTRUCTURES.gravity_sink.effect.holdTicks} ticks.
              The list is read at the moment of the grab, so a stale one
              catches the wrong people.
            </div>
          </div>
        );
      })()}

      {error && (
        <button className="megac__err" onClick={() => setError(null)}>⚠ {error}</button>
      )}
    </div>
  );
};

/**
 * The picker, shown on a colony ship that carries a Construction Module.
 * Rendered by ShipPanel rather than mounted globally, because it belongs
 * to a selected SHIP rather than a selected body.
 */
export const MegastructurePicker: React.FC<{
  shipId: string;
  anchorBodyId: string;
  anchorSoi: number;
  onBegin: (kind: MegastructureKind, variant: StructureVariant) => void;
}> = ({ onBegin }) => {
  const gate = useFeatureGate();
  const { gameState } = useGameContext();
  const [open, setOpen] = useState(false);
  const [pendingKind, setPendingKind] = useState<MegastructureKind | null>(null);
  // The player's own livery, so the previews show what will really be
  // built rather than a catalogue swatch.
  const myFaction = gameState.factions?.find(f => f.id === 'player');
  const myColor = myFaction?.color ?? '#4ecdc4';
  const myTrim = myFaction?.color2;

  const affordableKinds = MEGASTRUCTURE_KINDS.filter(
    k => gate.has(MEGASTRUCTURES[k].feature as FeatureId),
  );

  if (affordableKinds.length === 0) {
    return (
      <div className="megap__none">
        This ship carries a Construction Module, but you have not researched
        any structure to build with it yet.
      </div>
    );
  }

  if (!open) {
    return (
      <button className="megap__open" onClick={() => setOpen(true)}>
        🏗 Lay a megastructure foundation
      </button>
    );
  }

  // STEP TWO: which of the three silhouettes.
  //
  // Split into its own step rather than three buttons per row because
  // the two questions are not the same size. WHAT to build commits a
  // colony ship and thirty freighter runs; what it LOOKS like commits
  // nothing. Putting them side by side would make a cosmetic choice
  // wear the weight of a strategic one.
  if (pendingKind) {
    const d = MEGASTRUCTURES[pendingKind];
    return (
      <div className="megap">
        <div className="megap__head">Choose a look for your {d.label}</div>
        <div className="megap__variants">
          {/* Only what this kind HAS. A picker built on the full letter
              list would offer a warp gate two options that do not exist
              — the Mega Destroyer carries five silhouettes and most
              kinds carry three. */}
          {variantsFor(pendingKind).map(v => (
            <button
              key={v}
              className="megap__variant"
              onClick={() => { setOpen(false); setPendingKind(null); onBegin(pendingKind, v); }}
              title={STRUCTURE_VARIANT_NAMES[pendingKind][v]}
            >
              {/* Drawn in YOUR colours, because that is how it will
                  actually look on the map — a preview in catalogue grey
                  would be a preview of something else. */}
              <StructureIcon
                kind={pendingKind}
                variant={v}
                size={54}
                color={myColor}
                color2={myTrim}
              />
              <span className="megap__variantname">
                {STRUCTURE_VARIANT_NAMES[pendingKind][v]}
              </span>
            </button>
          ))}
        </div>
        <button className="megap__close" onClick={() => setPendingKind(null)}>Back</button>
      </div>
    );
  }

  return (
    <div className="megap">
      <div className="megap__head">Choose what to found</div>
      {affordableKinds.map((k) => {
        const d = MEGASTRUCTURES[k];
        const loads = Math.ceil(d.cost.metal / HOLD) + Math.ceil(d.cost.credits / HOLD);
        return (
          <button
            key={k}
            className="megap__opt"
            onClick={() => setPendingKind(k)}
          >
            <span className="megap__optglyph" style={{ color: d.color }}>{d.glyph}</span>
            <span className="megap__optbody">
              <span className="megap__optname">
                {d.label}
                <span className="megap__opthead" style={{ color: d.color }}>
                  {headlineFor(k)}
                </span>
              </span>
              {/* WHAT IT DOES, in the figures the tick will actually
                  apply — derived from the same effect block, so the
                  number a player weighs against the price is the number
                  they get. This is the moment a colony ship and thirty
                  freighter runs get committed; it should not require
                  going and reading a wiki. */}
              <span className="megap__optwhat">{effectSummary(k)}</span>
              <span className="megap__optcost">
                {d.cost.metal.toLocaleString()} metal · {d.cost.credits.toLocaleString()} credits
                <b> · {loads} freighter loads</b>
              </span>
            </span>
          </button>
        );
      })}
      <button className="megap__close" onClick={() => setOpen(false)}>Never mind</button>
    </div>
  );
};
