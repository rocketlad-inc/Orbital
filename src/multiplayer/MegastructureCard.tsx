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
  progressOf, remainingFor, loadsRemaining,
} from '../game/megastructures';
import {
  getPlacement, subscribePlacement, cancelPlacement,
} from '../game/megastructurePlacement';
import { useFeatureGate } from '../hooks/useFeatureGate';
import type { FeatureId } from '../game/researchUnlocks';
import './MegastructureCard.css';

const HOLD = 400;

export const MegastructureCard: React.FC = () => {
  const { gameState, uiState } = useGameContext();
  const mpActions = useMultiplayerActions();
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
            {complete ? 'Operational' : 'Under construction'}
            {!mine && ' · not yours'}
          </div>
        </div>
      </div>

      <p className="megac__blurb">{def.blurb}</p>

      {!complete && (
        <>
          <div className="megac__barwrap">
            <div
              className="megac__bar"
              style={{ width: `${(pct * 100).toFixed(1)}%`, background: def.color }}
            />
          </div>
          <div className="megac__pct">
            {(pct * 100).toFixed(1)}% built
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
          .filter(m => m.kind === 'warp_gate'
            && m.status === 'complete'
            && m.bodyId !== site.bodyId)
          .map(m => ({ m, body: gameState.bodies.find(b => b.id === m.bodyId) }))
          .filter(x => !!x.body && x.body.ownedBy === 'player');

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
                    disabled={busy || m.bodyId === site.partnerBodyId}
                    onClick={() => setPartner(m.bodyId)}
                    title={m.partnerBodyId && m.partnerBodyId !== site.bodyId
                      ? 'This gate is already wired elsewhere — pairing here drops that link'
                      : undefined}
                  >
                    Pair with {b!.name}
                    {m.partnerBodyId && m.partnerBodyId !== site.bodyId && ' (re-wires)'}
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
              Anyone can fly through this, including the people you built it
              against.
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
  onBegin: (kind: MegastructureKind) => void;
}> = ({ onBegin }) => {
  const gate = useFeatureGate();
  const [open, setOpen] = useState(false);

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
            onClick={() => { setOpen(false); onBegin(k); }}
          >
            <span className="megap__optglyph" style={{ color: d.color }}>{d.glyph}</span>
            <span className="megap__optbody">
              <span className="megap__optname">{d.label}</span>
              <span className="megap__optcost">
                {d.cost.metal} metal · {d.cost.credits} credits · {loads} freighter loads
              </span>
            </span>
          </button>
        );
      })}
      <button className="megap__close" onClick={() => setOpen(false)}>Never mind</button>
    </div>
  );
};
