// ============================================================
// BodyInspector - Resource readout + build UI for selected body
// ============================================================

import React, { useState, useEffect, useRef } from 'react';
import { useGameContext } from '../state/gameContext';
import { BuildPanel } from './BuildPanel';
import { bodyProductionRates } from '../game/economy';
import { getBodyFlavor } from '../game/bodyFlavor';
import {
  canHostCity, canHostStation, SETTLEMENT_DEFS, settlementYield, suggestSettlementName,
  COLLECTOR_COST,
  BUILDING_DEFS, buildingLevel, buildingCostForNextLevel, buildingTimeForNextLevel,
} from '../game/settlements';
import { SettlementType, BuildingKind, Settlement, Body } from '../types';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { BottomSheet } from './BottomSheet';
import {
  planTorchTransfer, fromG,
} from '../physics/torchTransfer';
import { bodyPosition } from '../physics/orbitalMechanics';
import './BodyInspector.css';

/** Per-Δv fuel cost when an asteroid is rammed via Trajectory Control
 *  Thrusters. Charged once at commit time to the faction pool. Tuned
 *  so an inner-system ram costs a meaningful chunk of an early-game
 *  fuel stockpile but doesn't bankrupt a mid-game empire. */
const RAM_FUEL_PER_DV = 50;

/** Asteroid trajectory thrusters are makeshift — they're industrial
 *  hardware bolted to a rock, not a torch drive plant. Effective
 *  acceleration is ~10× weaker than a torch ship's so the doom clock
 *  ticks slowly enough to give defenders real warning. */
const RAM_ASTEROID_G = 0.005;

export const BodyInspector: React.FC = () => {
  const { gameState, camera, uiState, deselectBody, focusBody } = useGameContext();

  if (!uiState.selectedBodyId) {
    return null;
  }

  const body = gameState.bodies.find(b => b.id === uiState.selectedBodyId);
  if (!body) {
    return null;
  }

  const ownerFaction = body.ownedBy
    ? gameState.factions.find(f => f.id === body.ownedBy)
    : null;

  // Count ships at this body
  const shipsHere = gameState.ships.filter(
    s => !s.transit && s.orbit.parentBodyId === body.id
  );

  const isFocused = camera.focusedBodyId === body.id;
  const toggleFocus = () => focusBody(isFocused ? undefined : body.id);

  // === Cardinal panel layout ===
  // After the UI overhaul, BodyInspector renders 4 cards around the
  // (zoomed-in) body instead of one stacked side panel:
  //   TOP    — name + flavor + yields + production note + body info
  //   LEFT   — cities at this body (or DysonSphere at Sol, where no
  //            city is possible)
  //   RIGHT  — stations at this body
  //   BOTTOM — Shipyard (BuildPanel) — ship class tiles
  //
  // SettlementsSection takes a typeFilter prop so the same component
  // mounts twice, once filtered to 'city' on the left, once filtered
  // to 'station' on the right. Each instance only shows the deploy
  // button for its own type.
  //
  // The planet-zoom-on-open behavior and the dismiss-on-pan-or-Esc
  // exit are deliberately NOT here yet — first iteration just lays
  // out the cardinal panels around whatever the camera is already
  // showing. Those behaviors land in a follow-up.
  return (
    <BottomSheet open={true} onClose={deselectBody} title={body.name.toUpperCase()}>
    <div className="body-focus" data-tutorial-id="body-inspector">

      {/* === TOP CARD === */}
      <div className="body-focus__top">
        <div className="panel-header">
          <span>{body.name.toUpperCase()}</span>
          <div className="panel-header-actions">
            <button
              className={`panel-focus ${isFocused ? 'active' : ''}`}
              onClick={toggleFocus}
              title={isFocused ? 'Stop following' : 'Camera follows this body'}
            >
              {isFocused ? '◉ FOLLOWING' : '○ FOLLOW'}
            </button>
            <button className="panel-close" onClick={deselectBody}>
              ✕
            </button>
          </div>
        </div>

        <div className="panel-body">
        {/* Flavor text — authored prose from src/game/bodyFlavor.ts.
            Renders nothing when empty so unauthored bodies don't show
            an awkward placeholder block. */}
        {(() => {
          const flavor = getBodyFlavor(body.id);
          if (!flavor) return null;
          return (
            <div
              data-tutorial-id="body-flavor"
              style={{
                fontSize: 11,
                lineHeight: 1.55,
                color: '#a8b8c8',
                fontStyle: 'italic',
                padding: '8px 10px',
                marginBottom: 10,
                borderLeft: '2px solid #4a6275',
                background: 'rgba(74, 98, 117, 0.08)',
                borderRadius: '0 3px 3px 0',
              }}
            >
              {flavor}
            </div>
          );
        })()}

        {body.resources && (() => {
          const production = bodyProductionRates(body);
          const hasProduction = production.fuel > 0 || production.ore > 0 || production.credits > 0;
          const settlementsHere = gameState.settlements.filter(s => s.bodyId === body.id);
          const playerSettlements = settlementsHere.filter(s => s.ownedBy === 'player');
          const freightersHere = gameState.ships.filter(
            s => s.class === 'freighter' && !s.transit && s.orbit.parentBodyId === body.id && s.ownedBy === 'player'
          );
          return (
            <>
              <div className="resources-grid">
                <div className="resource-item">
                  <div className="resource-label">FUEL</div>
                  <div className="resource-value">{body.resources.fuel}</div>
                </div>
                <div className="resource-item">
                  <div className="resource-label">GOLD</div>
                  <div className="resource-value">{body.resources.gold}</div>
                </div>
                <div className="resource-item">
                  <div className="resource-label">METAL</div>
                  <div className="resource-value">{body.resources.metal}</div>
                </div>
                <div className="resource-item">
                  <div className="resource-label">SCI</div>
                  <div className="resource-value">{body.resources.science}</div>
                </div>
              </div>
              {hasProduction && (
                <div className="production-summary" data-tutorial-id="body-production">
                  <div className="production-title">POTENTIAL YIELD / HARVEST</div>
                  <div className="production-rates">
                    {/* Math.round defensive — bodyProductionRates() multiplies
                        by PRODUCTION_MULTIPLIER (=1 today), so values land on
                        the integer body.resources today. If anyone tunes the
                        multiplier we don't want "+3.5 FUEL" to suddenly leak. */}
                    {production.fuel > 0 && (
                      <span className="production-rate">+{Math.round(production.fuel)} FUEL</span>
                    )}
                    {production.ore > 0 && (
                      <span className="production-rate">+{Math.round(production.ore)} ORE</span>
                    )}
                    {production.credits > 0 && (
                      <span className="production-rate">+{Math.round(production.credits)} CR</span>
                    )}
                  </div>
                  <div className="production-note">
                    {playerSettlements.length === 0
                      ? 'Deploy a city or station below to start production'
                      : freightersHere.length === 0
                        ? `${playerSettlements.length} settlement${playerSettlements.length > 1 ? 's' : ''} extracting — send a freighter here to ferry the stockpile to your resources (top-right)`
                        : `${playerSettlements.length} settlement${playerSettlements.length > 1 ? 's' : ''} extracting · ${freightersHere.length} freighter${freightersHere.length > 1 ? 's' : ''} ferrying to your resources`}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        <div className="body-info">
          <div className="info-row">
            <span className="label">TYPE</span>
            <span className="value">{body.type.toUpperCase()}</span>
          </div>
          {ownerFaction && (
            <div className="info-row">
              <span className="label">OWNER</span>
              <span className="value" style={{ color: ownerFaction.color }}>
                {ownerFaction.name.toUpperCase()}
              </span>
            </div>
          )}
          {body.parent && (
            <div className="info-row">
              <span className="label">PARENT</span>
              <span className="value">{body.parent.toUpperCase()}</span>
            </div>
          )}
          <div className="info-row">
            <span className="label">SOI</span>
            <span className="value">{body.soi === Infinity ? '∞' : body.soi.toFixed(0)}</span>
          </div>
          {shipsHere.length > 0 && (
            <div className="info-row">
              <span className="label">SHIPS</span>
              <span className="value">{shipsHere.length}</span>
            </div>
          )}
        </div>

        {/* Asteroid-only ram controls stay in the top card alongside
            the body info — they're contextual, not part of the
            city/station/shipyard split. */}
        {body.type === 'asteroid' && <RamControlsSection body={body} />}
        </div>
      </div>

      {/* === LEFT CARD === Cities (or Dyson Sphere at Sol) */}
      <div className="body-focus__left">
        {body.id === 'sol' ? (
          <DysonSpherePanel />
        ) : (
          <SettlementsSection bodyId={body.id} typeFilter="city" />
        )}
      </div>

      {/* === RIGHT CARD === Stations */}
      <div className="body-focus__right">
        <SettlementsSection bodyId={body.id} typeFilter="station" />
      </div>

      {/* === BOTTOM CARD === Shipyard */}
      <div className="body-focus__bottom">
        <BuildPanel />
      </div>

    </div>
    </BottomSheet>
  );
};

interface SettlementsSectionProps {
  bodyId: string;
  /** Restrict the section to one settlement type. Used by the cardinal
   *  body view to split the section into city-only (left card) and
   *  station-only (right card). When undefined, both kinds render and
   *  both deploy buttons show — same shape the section had before the
   *  split. */
  typeFilter?: 'city' | 'station';
}

const SettlementsSection: React.FC<SettlementsSectionProps> = ({ bodyId, typeFilter }) => {
  const {
    gameState, deploySettlement, selectSettlement, selectedSettlementId,
    buildCollector, queueBuilding, cancelBuilding,
  } = useGameContext();
  // Non-null only in multiplayer: mirror the local deploy to the server.
  const mpActions = useMultiplayerActions();

  // Inline name prompt state — when set, shows naming form for that type
  const [namingType, setNamingType] = useState<SettlementType | null>(null);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Server-side deploy rejection surfaced inline so the player isn't
  // left with a silent "button reset" UX. Cleared on the next attempt.
  // (Message mapping lives in multiplayer/errorMessages.ts.)
  const [deployError, setDeployError] = useState<string | null>(null);

  const body = gameState.bodies.find(b => b.id === bodyId);

  // Auto-focus and seed default name when prompt opens. On mobile the
  // BottomSheet caps at 55vh and the prompt can render below the fold
  // if there's a long settlements list; scrollIntoView before focus
  // keeps the input AND its FOUND CITY / CANCEL buttons visible above
  // the iOS keyboard.
  useEffect(() => {
    if (namingType && body) {
      setDraftName(suggestSettlementName(body, namingType, gameState.settlements));
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        try {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch { /* older Safari lacks smooth */ }
        el.focus();
        el.select();
      }, 0);
    }
  }, [namingType, body, gameState.settlements]);

  if (!body) return null;

  const settlements = gameState.settlements
    .filter(s => s.bodyId === bodyId)
    .filter(s => !typeFilter || s.type === typeFilter);

  // Only freighters can deliver settlement materials — combat ships can't deploy.
  //
  // Extra gate (MP): also reject ships that still carry a committed
  // transfer order. Background: gameContext.advanceToTick runs locally
  // every tick in MP too, so a torch arrival fires on the client a
  // tick or two before the server's alarm processes it. Without this
  // check, the deploy button is enabled in that desync window, the
  // player clicks, and the server returns no_presence because its
  // ships.parent_body_id still says 'earth' (or wherever). The
  // committed-order check is the proxy for "server has confirmed
  // arrival" — committed orders only clear once /state polls back the
  // server's executed/cleared row.
  const playerFreighterHere = gameState.ships.find(s => {
    if (s.ownedBy !== 'player') return false;
    if (s.transit) return false;
    if (s.orbit.parentBodyId !== bodyId) return false;
    if (s.class !== 'freighter') return false;
    // In MP, if the server still has an unfinished transfer node on
    // this ship, the client has locally arrived but the server hasn't —
    // hold off until /state confirms.
    if (mpActions && s.orders.some(o =>
      o.type === 'transfer' && (o.status === 'committed' || o.status === 'planned')
    )) {
      return false;
    }
    return true;
  });
  const canBuildHere = !!playerFreighterHere;

  // Diagnostic: is there a NON-player freighter at this body? Used to
  // refine the hint copy — the player might be looking at the enemy's
  // ship and wondering why their button is disabled.
  const enemyFreighterHere = !playerFreighterHere && gameState.ships.some(s =>
    s.ownedBy !== 'player' && !s.transit && s.orbit.parentBodyId === bodyId && s.class === 'freighter'
  );
  // Diagnostic: is the player's freighter mid-flight to here? Differentiates
  // "send one" from "wait, yours is on its way."
  const playerFreighterEnRoute = !playerFreighterHere && gameState.ships.some(s =>
    s.ownedBy === 'player' && s.class === 'freighter' && (
      // Active torch burn pointed here
      s.transit?.currentTransfer.targetBodyId === bodyId
      // Or a committed/planned transfer order pointed here (MP server still has it)
      || s.orders.some(o =>
        o.type === 'transfer'
        && (o.status === 'committed' || o.status === 'planned')
        && o.capturedAtBody === bodyId
      )
    )
  );
  // Diagnostic: does the player have a NON-freighter ship parked here?
  // The most common confusion — player sees their frigate/corvette at the
  // body, assumes any of their ships counts, clicks deploy, server says
  // no_presence. Name the offending ship so the hint is concrete.
  const playerNonFreighterHere = !playerFreighterHere && gameState.ships.find(s =>
    s.ownedBy === 'player'
    && !s.transit
    && s.orbit.parentBodyId === bodyId
    && s.class !== 'freighter'
  );
  // Single source of truth for the disabled-button hint text. Used by
  // both the button title attribute and the visible hint below.
  const noFreighterHint = playerFreighterEnRoute
    ? 'Your freighter is en route — wait for it to arrive'
    : playerNonFreighterHere
      ? `Your ${playerNonFreighterHere.class} here can't deploy — only freighters can.`
      : enemyFreighterHere
        ? 'That freighter belongs to an enemy. Send YOUR own to deploy.'
        : 'Send a freighter to orbit to deploy';

  const cityAllowed = canHostCity(body);
  const stationAllowed = canHostStation(body);

  const playerRes = gameState.resources['player'];
  const canAffordCity = playerRes
    && playerRes.fuel >= SETTLEMENT_DEFS.city.cost.fuel
    && playerRes.ore >= SETTLEMENT_DEFS.city.cost.ore
    && playerRes.credits >= SETTLEMENT_DEFS.city.cost.credits;
  const canAffordStation = playerRes
    && playerRes.fuel >= SETTLEMENT_DEFS.station.cost.fuel
    && playerRes.ore >= SETTLEMENT_DEFS.station.cost.ore
    && playerRes.credits >= SETTLEMENT_DEFS.station.cost.credits;

  const handleStartDeploy = (type: SettlementType) => {
    setNamingType(type);
  };

  const handleConfirm = () => {
    if (!namingType) return;
    setDeployError(null);
    const name = draftName.trim();
    if (mpActions) {
      // Multiplayer: server is canonical for resource deduction +
      // settlement creation. Skip the local deploySettlement() which
      // would flash 2× deducted resources for ~1.5s until /state poll.
      // Surface server rejections inline so the deploy button doesn't
      // look like it "did nothing" — without this, a server-side gate
      // (no_presence / no_surface / insufficient_resources) reset the
      // UI to a fresh state with no explanation.
      const typeAtClick = namingType;
      const nameAtClick = name;
      mpActions.deploySettlement({ bodyId, type: typeAtClick, name: nameAtClick || undefined })
        .then(res => {
          if (!res.ok) {
            setDeployError(humanizeMpError(res.code, res.error, 'deploy'));
          }
        });
    } else {
      deploySettlement(bodyId, namingType, name || undefined);
    }
    setNamingType(null);
    setDraftName('');
  };

  const handleCancel = () => {
    setNamingType(null);
    setDraftName('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div className="settlements-section">
      <div className="section-title">SETTLEMENTS</div>

      {settlements.length === 0 && !namingType && (
        <div className="no-orders">No settlements at this body</div>
      )}

      {settlements.map(s => {
        const owner = gameState.factions.find(f => f.id === s.ownedBy);
        const isSelected = selectedSettlementId === s.id;
        const yieldRate = settlementYield(s, body);
        const yieldStr = [
          yieldRate.fuel > 0.05 ? `+${yieldRate.fuel.toFixed(1)}F` : null,
          yieldRate.ore > 0.05 ? `+${yieldRate.ore.toFixed(1)}O` : null,
          yieldRate.credits > 0.05 ? `+${yieldRate.credits.toFixed(1)}C` : null,
        ].filter(Boolean).join(' ');
        const isMine = s.ownedBy === 'player';
        const playerRes = gameState.resources['player'];
        const canAffordCollector = !!playerRes
          && playerRes.ore >= COLLECTOR_COST.ore
          && playerRes.credits >= COLLECTOR_COST.credits;

        return (
          <div
            key={s.id}
            className={`settlement-row ${isSelected ? 'selected' : ''}`}
            onClick={() => selectSettlement(isSelected ? undefined : s.id)}
          >
            <div className="settlement-info">
              <div
                className="settlement-name"
                style={{ color: owner?.color, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span>{s.type === 'city' ? '■' : '◆'} {s.name}</span>
                {s.hasCollector && (
                  // Collector chip: small badge that mirrors the body
                  // inspector's "this is a logistics endpoint" status.
                  // Without one of these anywhere in the empire, every
                  // settlement stockpile is stranded.
                  <span
                    title="Collector — receives stockpile drains from this empire's settlements"
                    style={{
                      fontSize: 8, letterSpacing: '0.12em',
                      padding: '1px 5px', borderRadius: 3,
                      border: '1px solid #4ecdc4', color: '#4ecdc4',
                      background: 'rgba(78, 205, 196, 0.08)',
                    }}
                  >◆ COLLECTOR</span>
                )}
              </div>
              <div className="settlement-stats">
                <span>HP {Math.round(s.hp)}/{s.maxHp}</span>
                <span>POP {s.population}</span>
                <span className="yield">{yieldStr || '–'}/harvest</span>
              </div>
              {(s.stockpile.fuel > 0 || s.stockpile.ore > 0 || s.stockpile.credits > 0) && (
                <div className="settlement-stockpile">
                  STOCK: {Math.round(s.stockpile.fuel)}F {Math.round(s.stockpile.ore)}O {Math.round(s.stockpile.credits)}C
                </div>
              )}
              {isMine && !s.hasCollector && (
                <button
                  data-tutorial-id="collector-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Local optimistic flip first — UI feels instant.
                    // In MP the server is authoritative for resources;
                    // post the intent so the next /state poll doesn't
                    // wipe the local change and refund the player's
                    // money without delivering the collector.
                    const localOk = buildCollector(s.id);
                    if (localOk && mpActions) {
                      // Surface server rejections so the player learns why
                      // the collector chip flickered ON then back OFF (e.g.
                      // server said "insufficient_resources" because a
                      // concurrent action drained the pool). Reuses
                      // deployError because both errors live in the same
                      // SettlementsSection — one chip is enough.
                      mpActions.buildCollector(s.id).then(res => {
                        if (!res.ok) setDeployError(humanizeMpError(res.code, res.error, 'deploy'));
                      });
                    }
                  }}
                  disabled={!canAffordCollector}
                  title={canAffordCollector
                    ? `Build a collector here. Drains ${COLLECTOR_COST.ore}O / ${COLLECTOR_COST.credits}C from your pool.`
                    : `Need ${COLLECTOR_COST.ore} ore + ${COLLECTOR_COST.credits} credits.`}
                  style={{
                    marginTop: 6,
                    padding: '4px 10px',
                    background: canAffordCollector ? 'transparent' : 'transparent',
                    color: canAffordCollector ? '#4ecdc4' : '#5a7080',
                    border: `1px solid ${canAffordCollector ? '#4ecdc4' : '#2a3d50'}`,
                    borderRadius: 3,
                    fontFamily: 'inherit', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                    cursor: canAffordCollector ? 'pointer' : 'default',
                  }}
                >+ COLLECTOR ({COLLECTOR_COST.ore}O / {COLLECTOR_COST.credits}C)</button>
              )}
              {isMine && (
                <div data-tutorial-id="buildings-strip">
                <BuildingsStrip
                  settlement={s}
                  body={body}
                  playerRes={playerRes}
                  currentTick={gameState.currentTick}
                  queueBuilding={(sid, kind) => {
                    // Optimistic local mutation + MP server post.
                    // Mirrors the buildCollector flow: instant UI feel
                    // in SP; in MP the server reconciles within ~1.5s
                    // and locks in the cost deduction so the next
                    // /state poll doesn't refund.
                    const ok = queueBuilding(sid, kind);
                    if (ok && mpActions) {
                      mpActions.queueBuilding(sid, kind).then(res => {
                        if (!res.ok) setDeployError(humanizeMpError(res.code, res.error, 'build'));
                      });
                    }
                    return ok;
                  }}
                  cancelBuilding={(sid) => {
                    const ok = cancelBuilding(sid);
                    if (ok && mpActions) {
                      mpActions.cancelBuilding(sid).then(res => {
                        if (!res.ok) setDeployError(humanizeMpError(res.code, res.error, 'build'));
                      });
                    }
                    return ok;
                  }}
                />
                </div>
              )}
            </div>
          </div>
        );
      })}

      {namingType ? (
        <div className="deploy-prompt">
          <div className="deploy-prompt-label">
            NAME YOUR {namingType === 'city' ? 'CITY' : 'STATION'}
          </div>
          <input
            ref={inputRef}
            className="deploy-name-input"
            type="text"
            value={draftName}
            maxLength={32}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`e.g. ${suggestSettlementName(body, namingType, gameState.settlements)}`}
          />
          <div className="deploy-prompt-actions">
            <button className="btn-confirm" onClick={handleConfirm}>
              {namingType === 'city' ? '■ FOUND CITY' : '◆ LAUNCH STATION'}
            </button>
            <button className="btn-cancel" onClick={handleCancel}>CANCEL</button>
          </div>
        </div>
      ) : (
        <>
          <div className="deploy-buttons" data-tutorial-id="deploy-buttons">
            {cityAllowed && (!typeFilter || typeFilter === 'city') && (
              <button
                className="deploy-btn"
                disabled={!canBuildHere || !canAffordCity}
                onClick={() => handleStartDeploy('city')}
                title={
                  !canBuildHere ? noFreighterHint
                  : !canAffordCity ? `Need ${SETTLEMENT_DEFS.city.cost.fuel}F/${SETTLEMENT_DEFS.city.cost.ore}O/${SETTLEMENT_DEFS.city.cost.credits}C`
                  : `Deploy a city (${SETTLEMENT_DEFS.city.cost.fuel}F/${SETTLEMENT_DEFS.city.cost.ore}O/${SETTLEMENT_DEFS.city.cost.credits}C)`
                }
              >
                ■ DEPLOY CITY
              </button>
            )}
            {stationAllowed && (!typeFilter || typeFilter === 'station') && (
              <button
                className="deploy-btn"
                disabled={!canBuildHere || !canAffordStation}
                onClick={() => handleStartDeploy('station')}
                title={
                  !canBuildHere ? noFreighterHint
                  : !canAffordStation ? `Need ${SETTLEMENT_DEFS.station.cost.fuel}F/${SETTLEMENT_DEFS.station.cost.ore}O/${SETTLEMENT_DEFS.station.cost.credits}C`
                  : `Deploy a station (${SETTLEMENT_DEFS.station.cost.fuel}F/${SETTLEMENT_DEFS.station.cost.ore}O/${SETTLEMENT_DEFS.station.cost.credits}C)`
                }
              >
                ◆ DEPLOY STATION
              </button>
            )}
          </div>

          {!canBuildHere && (cityAllowed || stationAllowed) && (
            <div className="deploy-hint">{noFreighterHint}</div>
          )}

          {deployError && (
            // Server rejected the deploy. Show why so the player can
            // act on it instead of clicking the button again with the
            // same broken preconditions. Click the chip to dismiss.
            <button
              onClick={() => setDeployError(null)}
              style={{
                marginTop: 6, padding: '6px 10px',
                background: 'rgba(255, 94, 94, 0.1)',
                border: '1px solid #ff5e5e', borderRadius: 4,
                color: '#ff5e5e', fontSize: 10, lineHeight: 1.4,
                fontFamily: 'inherit', textAlign: 'left',
                cursor: 'pointer', width: '100%',
              }}
              title="Click to dismiss"
            >⚠ {deployError}</button>
          )}
        </>
      )}
    </div>
  );
};

// (Deploy error mapping moved to shared multiplayer/errorMessages.ts —
// humanizeMpError(code, fallback, 'deploy'). The same helper now serves
// build / transfer / research / TBM-toggle so we don't drift across
// four near-identical switch statements.)

// ============================================================
// Per-settlement Buildings strip — Forge / Mint / Lab on cities,
// Weapons / Shipyard on stations. Each row shows current level,
// next-level cost, and either a "+ Upgrade" button or an in-flight
// progress bar with cancel.
// ============================================================

const CITY_BUILDINGS: BuildingKind[] = ['forge', 'mint', 'lab'];
const STATION_BUILDINGS: BuildingKind[] = ['weapons', 'shipyard'];
// Asteroid-only city extension: when the parent body's type is
// 'asteroid', append trajectory_thrusters to the available city
// buildings. Kept separate from CITY_BUILDINGS so non-asteroid cities
// don't see the option.
const ASTEROID_CITY_EXTRA: BuildingKind[] = ['trajectory_thrusters'];

interface BuildingsStripProps {
  settlement: Settlement;
  body: Body;
  playerRes: { fuel: number; ore: number; credits: number } | undefined;
  currentTick: number;
  queueBuilding: (settlementId: string, kind: BuildingKind) => boolean;
  cancelBuilding: (settlementId: string) => boolean;
}

const BuildingsStrip: React.FC<BuildingsStripProps> = ({
  settlement, body, playerRes, currentTick, queueBuilding, cancelBuilding,
}) => {
  const baseKinds = settlement.type === 'city' ? CITY_BUILDINGS : STATION_BUILDINGS;
  const kinds: BuildingKind[] = (settlement.type === 'city' && body.type === 'asteroid')
    ? [...baseKinds, ...ASTEROID_CITY_EXTRA]
    : baseKinds;
  const q = settlement.buildingQueue;

  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 6,
        borderTop: '1px dashed rgba(78, 205, 196, 0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10, letterSpacing: '0.14em', fontWeight: 700,
          color: '#b8c8d6', textTransform: 'uppercase',
        }}
      >Buildings</div>

      {kinds.map(kind => {
        const def = BUILDING_DEFS[kind];
        const level = buildingLevel(settlement, kind);
        const cost = buildingCostForNextLevel(kind, level);
        const ticks = buildingTimeForNextLevel(kind, level);
        const inFlight = q?.kind === kind;
        const queueBusy = !!q && !inFlight;
        const canAfford = !!playerRes
          && playerRes.fuel    >= cost.fuel
          && playerRes.ore     >= cost.ore
          && playerRes.credits >= cost.credits;
        const canQueue = !queueBusy && !inFlight && canAfford;

        const costParts: string[] = [];
        if (cost.fuel    > 0) costParts.push(`${cost.fuel}F`);
        if (cost.ore     > 0) costParts.push(`${cost.ore}O`);
        if (cost.credits > 0) costParts.push(`${cost.credits}C`);
        const costStr = costParts.join(' ');

        // Effect descriptor for next level
        let effectStr: string;
        if (def.yieldBoost) {
          const pct = Math.round(def.yieldBoost.perLevel * 100);
          effectStr = `+${pct}% ${def.yieldBoost.resource}`;
        } else if (def.combatBoost) {
          effectStr = `+${def.combatBoost.damagePerLevel} dmg/tick`;
        } else if (def.shipyardBoost) {
          effectStr = `+${def.shipyardBoost.slotsPerLevel} build slot`;
        } else {
          effectStr = '';
        }

        return (
          <div
            key={kind}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 0',
              fontSize: 10,
            }}
          >
            <span
              style={{
                minWidth: 64,
                fontWeight: 600,
                color: level > 0 ? '#d8e4ee' : '#a8b8c8',
                letterSpacing: '0.05em',
              }}
            >
              {def.displayName} <span style={{ color: '#4ecdc4' }}>L{level}</span>
            </span>

            {inFlight && q ? (
              <>
                <div
                  style={{
                    flex: 1,
                    height: 6,
                    background: 'rgba(42, 61, 80, 0.6)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                  title={`Building ${def.displayName} L${q.targetLevel} — ETA T+${Math.max(0, Math.round(q.completeTick - currentTick))} ticks`}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, ((currentTick - q.startTick) / (q.completeTick - q.startTick)) * 100)}%`,
                      background: 'linear-gradient(90deg, #4ecdc4, #6ee7b7)',
                    }}
                  />
                </div>
                <span style={{ color: '#b8c8d6', minWidth: 50, textAlign: 'right', fontWeight: 600 }}>
                  {/* Math.round before display — completeTick - currentTick
                      can leak floats from upstream tick arithmetic (e.g.
                      currentTick is incremented in fractional steps when
                      time scale is non-1x), and a label like
                      "T+26.91330444444418" reads as a UI bug, not as
                      precision. */}
                  T+{Math.max(0, Math.round(q.completeTick - currentTick))}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); cancelBuilding(settlement.id); }}
                  title="Cancel — refunds 50% of cost."
                  style={{
                    background: 'transparent',
                    color: '#ff8888',
                    border: '1px solid #5a2a30',
                    borderRadius: 3,
                    padding: '2px 6px',
                    fontFamily: 'inherit', fontSize: 9, fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >✕</button>
              </>
            ) : (
              <>
                <span
                  style={{ flex: 1, color: '#b8c8d6', fontStyle: 'italic' }}
                  title={def.description}
                >
                  {effectStr} · {ticks}t · {costStr}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); queueBuilding(settlement.id, kind); }}
                  disabled={!canQueue}
                  title={
                    queueBusy ? `Another upgrade is in flight (${BUILDING_DEFS[q!.kind].displayName})`
                    : !canAfford ? `Need ${costStr}`
                    : `Upgrade ${def.displayName} → L${level + 1} (${ticks} ticks)`
                  }
                  style={{
                    padding: '2px 8px',
                    background: 'transparent',
                    color: canQueue ? '#4ecdc4' : '#5a7080',
                    border: `1px solid ${canQueue ? '#4ecdc4' : '#2a3d50'}`,
                    borderRadius: 3,
                    fontFamily: 'inherit', fontSize: 9, fontWeight: 600,
                    cursor: canQueue ? 'pointer' : 'default',
                  }}
                >+ L{level + 1}</button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ============================================================
// RamControlsSection — asteroid-only doomsday-weapon UI.
//
// Visible only on bodies where type === 'asteroid'. Three states:
//
//   1. Asteroid already in flight (body.ramPlan set) — show ETA +
//      target name, no actions.
//   2. Caller owns a settlement here with trajectory_thrusters built
//      — show "RAM TARGET" button. Clicking opens a target picker
//      modal: select any non-self body, see preview (ETA / Δv /
//      fuel cost), confirm to commit.
//   3. Otherwise — hidden or shown as "build Trajectory Control
//      Thrusters to enable" prompt.
//
// Math: brachistochrone toward the predicted future position of the
// target body. Same iterative solve as ship transfers; the asteroid
// supplies its current pos/vel (from natural orbit) instead of a
// ship's launch state. Plan is computed client-side and posted to
// the server via mpActions.ram in MP.
// ============================================================
const RamControlsSection: React.FC<{ body: Body }> = ({ body }) => {
  const { gameState, setGameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [pickedTargetId, setPickedTargetId] = useState<string | null>(null);
  const [ramError, setRamError] = useState<string | null>(null);

  // STATE 1 — already in flight.
  if (body.ramPlan) {
    const target = gameState.bodies.find(b => b.id === body.ramPlan!.targetBodyId);
    const eta = Math.max(0, body.ramPlan.arriveTick - gameState.currentTick);
    const launcher = gameState.factions.find(f => f.id === body.ramPlan!.ownedBy);
    return (
      <div style={{
        marginTop: 8, padding: 8,
        border: '1px solid #ff4444', borderRadius: 4,
        background: 'rgba(80, 20, 20, 0.4)',
      }}>
        <div style={{ color: '#ff8888', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em' }}>
          ⚠ ASTEROID WEAPON IN FLIGHT
        </div>
        <div style={{ color: '#e8c8b8', fontSize: 10, marginTop: 4 }}>
          {body.name} → {target?.name ?? '?'}<br />
          Impact in T-{eta.toFixed(0)} ticks<br />
          Launched by {launcher?.name ?? body.ramPlan.ownedBy}
        </div>
      </div>
    );
  }

  // STATE 2 — show RAM only if caller has TT built here.
  const mySettlements = gameState.settlements.filter(
    s => s.bodyId === body.id && s.ownedBy === 'player',
  );
  const hasThrusters = mySettlements.some(
    s => (s.buildings?.trajectory_thrusters ?? 0) >= 1,
  );

  if (!hasThrusters) {
    // STATE 3 — show a hint. Reword by what the player still needs:
    // if there's no settlement yet, the first hurdle is parking a
    // freighter and founding a city. If a settlement exists but
    // Thrusters aren't queued, point straight at the building.
    const hintCopy = mySettlements.length === 0
      ? 'Park a freighter here, found a city, then queue Trajectory Control Thrusters to weaponize this rock.'
      : 'Queue Trajectory Control Thrusters at your settlement here to weaponize this rock. (Buildings panel below.)';
    return (
      <div style={{
        marginTop: 8, padding: '8px 10px',
        fontSize: 10, color: '#a0b0c0', fontStyle: 'italic',
        background: 'rgba(74, 98, 117, 0.10)',
        borderLeft: '2px solid #4a6275', borderRadius: '0 3px 3px 0',
      }}>
        ☄ This is a rogue asteroid — small, mineable, and weaponizable.
        <br /><br />
        {hintCopy}
      </div>
    );
  }

  // STATE 2 — show RAM button + (when picked) preview.
  const playerFaction = gameState.factions.find(f => f.id === 'player');
  const baseAccel = fromG(playerFaction?.engineG ?? RAM_ASTEROID_G);
  // Plan from current asteroid state. Position from bodyPosition;
  // velocity via finite difference (works for circular AND eccentric
  // Kepler orbits — and we don't need closed-form derivative since
  // this is called once per render, not per integration step).
  const launchPos = bodyPosition(body, gameState.currentTick, gameState.bodies);
  const dh = 0.01;
  const p1 = bodyPosition(body, gameState.currentTick - dh, gameState.bodies);
  const p2 = bodyPosition(body, gameState.currentTick + dh, gameState.bodies);
  const fullVel = {
    x: (p2.x - p1.x) / (2 * dh),
    y: (p2.y - p1.y) / (2 * dh),
  };

  // Bodies the player can target. Skip self + Sol-warning aside; the
  // server allows Sol but the asteroid evaporates harmlessly there.
  const targets = gameState.bodies.filter(b =>
    b.id !== body.id && !b.destroyedAtTick,
  );

  const pickedTarget = pickedTargetId
    ? targets.find(b => b.id === pickedTargetId) ?? null
    : null;

  let plan: ReturnType<typeof planTorchTransfer> = null;
  let fuelCost = 0;
  if (pickedTarget) {
    plan = planTorchTransfer(
      { pos: launchPos, vel: fullVel },
      pickedTarget.id,
      baseAccel,
      baseAccel,
      gameState.currentTick,
      gameState.bodies,
    );
    if (plan) fuelCost = Math.ceil(plan.totalDv * RAM_FUEL_PER_DV);
  }

  const playerRes = gameState.resources['player'];
  const canAfford = !!plan && !!playerRes && playerRes.fuel >= fuelCost;

  const handleConfirm = () => {
    if (!plan || !pickedTarget) return;
    setRamError(null);
    // Local optimistic apply: set body.ramPlan + deduct fuel from
    // player pool. The server will reconcile via /state.
    const newRamPlan = {
      targetBodyId: plan.targetBodyId,
      startTick: plan.startTick,
      flipTick: plan.flipTick,
      arriveTick: plan.arriveTick,
      acceleration: plan.acceleration,
      startPos: { x: plan.startPos.x, y: plan.startPos.y },
      startVel: { x: plan.startVel.x, y: plan.startVel.y },
      interceptPos: { x: plan.interceptPos.x, y: plan.interceptPos.y },
      totalDv: plan.totalDv,
      ownedBy: 'player',
    };
    // Local optimistic update: set the ramPlan so the renderer + map
    // panel reflect the launch immediately. In MP, skip the local
    // fuel deduction — the server is canonical and the next /state
    // poll will reconcile within ~1.5s. Without that guard the
    // player saw a brief "fuel down" → "fuel back" flash if the
    // server's row landed after the poll. SP still needs the local
    // deduction since there's no server reconciling.
    setGameState({
      ...gameState,
      bodies: gameState.bodies.map(b =>
        b.id === body.id ? { ...b, ramPlan: newRamPlan } : b,
      ),
      resources: mpActions ? gameState.resources : {
        ...gameState.resources,
        player: playerRes
          ? { ...playerRes, fuel: Math.max(0, playerRes.fuel - fuelCost) }
          : playerRes,
      },
    });
    if (mpActions) {
      mpActions.ram({
        bodyId: body.id,
        targetBodyId: plan.targetBodyId,
        startTick: plan.startTick,
        flipTick: plan.flipTick,
        arriveTick: plan.arriveTick,
        acceleration: plan.acceleration,
        startPos: plan.startPos,
        startVel: plan.startVel,
        interceptPos: plan.interceptPos,
        totalDv: plan.totalDv,
        fuelCost,
      }).then(res => {
        if (!res.ok) {
          setRamError(humanizeMpError(res.code, res.error, 'ram'));
        }
      });
    }
    setTargetPickerOpen(false);
    setPickedTargetId(null);
  };

  return (
    <div style={{ marginTop: 8 }}>
      {!targetPickerOpen ? (
        <button
          onClick={() => setTargetPickerOpen(true)}
          style={{
            background: 'rgba(180, 40, 40, 0.2)',
            color: '#ff9090',
            border: '1px solid #b04040',
            borderRadius: 3,
            padding: '6px 10px',
            fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
            cursor: 'pointer', width: '100%',
          }}
        >▶ RAM TARGET</button>
      ) : (
        <div style={{
          border: '1px solid #b04040', borderRadius: 4, padding: 8,
          background: 'rgba(40, 20, 20, 0.6)',
        }}>
          <div style={{ fontSize: 10, color: '#ff9090', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 6 }}>
            PICK TARGET BODY
          </div>
          <select
            value={pickedTargetId ?? ''}
            onChange={(e) => setPickedTargetId(e.target.value || null)}
            style={{
              width: '100%', padding: '4px 6px', marginBottom: 6,
              background: '#0a1018', color: '#c8d4e0',
              border: '1px solid #2a3d50', fontSize: 11,
            }}
          >
            <option value="">— select —</option>
            {targets.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          {plan && pickedTarget && (
            <div style={{ fontSize: 10, color: '#e0d0c0', marginBottom: 6, lineHeight: 1.4 }}>
              Crash {body.name} into {pickedTarget.name}<br />
              ETA: T+{(plan.arriveTick - gameState.currentTick).toFixed(0)} ticks<br />
              Δv: {plan.totalDv.toFixed(1)} · Fuel cost: {fuelCost}<br />
              {pickedTarget.id === 'sol'
                ? <span style={{ color: '#ffcc66' }}>Sol target — asteroid will evaporate (no effect)</span>
                : <span style={{ color: '#ff8888' }}>On impact: settlements destroyed, yields halved</span>}
            </div>
          )}
          {plan && pickedTarget && !canAfford && (
            <div style={{ fontSize: 10, color: '#ff8080', marginBottom: 6 }}>
              Not enough fuel ({playerRes?.fuel ?? 0} / {fuelCost})
            </div>
          )}
          {ramError && (
            <div style={{ fontSize: 10, color: '#ff8080', marginBottom: 6 }}>{ramError}</div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={handleConfirm}
              disabled={!plan || !canAfford}
              style={{
                flex: 1, padding: '6px 10px',
                background: canAfford ? 'rgba(180, 40, 40, 0.4)' : 'rgba(40, 40, 40, 0.4)',
                color: canAfford ? '#ff9090' : '#666',
                border: `1px solid ${canAfford ? '#b04040' : '#333'}`,
                borderRadius: 3, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                cursor: canAfford ? 'pointer' : 'default',
              }}
            >▶ CONFIRM IMPACT</button>
            <button
              onClick={() => { setTargetPickerOpen(false); setPickedTargetId(null); setRamError(null); }}
              style={{
                padding: '6px 10px',
                background: 'transparent', color: '#8898a4',
                border: '1px solid #3a4a58', borderRadius: 3,
                fontSize: 10, cursor: 'pointer',
              }}
            >CANCEL</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// DysonSpherePanel — Sol-only megaproject UI.
//
// State machine:
//   no sphere yet                  → "Foundation slot open" + initiate button
//   sphere exists, you control it  → progress bar + per-resource breakdown
//   sphere exists, rival controls  → enemy progress display (intel value)
// ============================================================
const DysonSpherePanel: React.FC = () => {
  const { gameState, initiateDysonSphere } = useGameContext();
  // Non-null in MP — we mirror initiate to the server so the per-tick
  // delivery loop runs against the server's authoritative dyson_*
  // columns. Server response (success or error) round-trips via the
  // next /state poll, which is when the local panel actually flips
  // from "no sphere yet" to "in progress".
  const mpActions = useMultiplayerActions();
  // Megaproject stakes are high (one foundation per game). If the
  // server rejects (someone else just laid it, station not on Sol,
  // station not yours), the player needs to know — the chip
  // disappearing isn't an obvious failure signal.
  const [dysonError, setDysonError] = useState<string | null>(null);
  const dyson = gameState.dysonSphere;

  if (dyson) {
    return <DysonSphereProgress />;
  }

  // No sphere yet — show eligible player Sol stations + initiate button.
  const playerStations = gameState.settlements.filter(s =>
    s.ownedBy === 'player' && s.type === 'station' && s.bodyId === 'sol'
  );

  return (
    <div className="settlements-section" data-tutorial-id="dyson-sphere-section" style={{ marginTop: 12 }}>
      <div className="section-title" style={{ color: '#ffb84d' }}>
        DYSON SPHERE
      </div>
      <div style={{
        fontSize: 10, color: '#a8b8c8', marginBottom: 8, lineHeight: 1.5,
      }}>
        The Sol megaproject. Lay the foundation at a Sol-orbit station,
        then park freighters here to deliver resources every tick.
        Target: 10K fuel · 15K ore · 15K credits · 10K science.
        Completing it wins the match by Engineering Victory.
      </div>

      {playerStations.length === 0 ? (
        <div style={{
          fontSize: 10, color: '#ffb84d', fontStyle: 'italic',
          padding: '6px 8px', border: '1px dashed #ffb84d', borderRadius: 3,
        }}>
          Deploy a station in Sol orbit first to host the foundation.
        </div>
      ) : (
        playerStations.map(s => (
          <button
            key={s.id}
            onClick={() => {
              // SP: mutate local state directly so the panel updates
              // immediately. MP: also POST to the server so the per-tick
              // delivery loop fires; /state will reconcile within
              // ~1.5s and the local state will pick up the server-side
              // dyson_sphere snapshot.
              initiateDysonSphere(s.id);
              if (mpActions) {
                setDysonError(null);
                mpActions.initiateDysonSphere(s.id).then(res => {
                  if (!res.ok) {
                    setDysonError(humanizeMpError(res.code, res.error, 'build'));
                    // eslint-disable-next-line no-console
                    console.warn('initiateDysonSphere rejected by server:', res.error);
                  }
                });
              }
            }}
            style={{
              display: 'block', width: '100%',
              marginBottom: 4, padding: '8px 10px',
              background: 'rgba(255, 184, 77, 0.08)',
              color: '#ffb84d', border: '1px solid #ffb84d',
              borderRadius: 3,
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.1em', cursor: 'pointer',
            }}
            title={`Lay the Dyson Sphere foundation on ${s.name}. One-shot per game — destroying the station collapses the entire project.`}
          >
            ◆ INITIATE AT {s.name.toUpperCase()}
          </button>
        ))
      )}
      {dysonError && (
        // Megaproject rejection — clearly bad news. Show as a red chip
        // below the initiate buttons.
        <button
          onClick={() => setDysonError(null)}
          style={{
            marginTop: 8, padding: '6px 10px',
            background: 'rgba(255, 94, 94, 0.1)',
            border: '1px solid #ff5e5e', borderRadius: 4,
            color: '#ff5e5e', fontSize: 10, lineHeight: 1.4,
            fontFamily: 'inherit', textAlign: 'left',
            cursor: 'pointer', width: '100%',
          }}
          title="Click to dismiss"
        >⚠ {dysonError}</button>
      )}
    </div>
  );
};

const DysonSphereProgress: React.FC = () => {
  const { gameState } = useGameContext();
  const dyson = gameState.dysonSphere;
  if (!dyson) return null;

  const station = gameState.settlements.find(s => s.id === dyson.foundationSettlementId);
  const controller = gameState.factions.find(f => f.id === dyson.controllerFactionId);
  const isMine = dyson.controllerFactionId === 'player';
  const pct = dyson.maxHp > 0 ? (dyson.hp / dyson.maxHp) * 100 : 0;

  const rows: Array<{ label: string; acc: number; tgt: number; color: string }> = [
    { label: 'Fuel',    acc: dyson.accumulated.fuel,    tgt: dyson.target.fuel,    color: '#ffb84d' },
    { label: 'Ore',     acc: dyson.accumulated.ore,     tgt: dyson.target.ore,     color: '#a0a0a0' },
    { label: 'Credits', acc: dyson.accumulated.credits, tgt: dyson.target.credits, color: '#ffd700' },
    { label: 'Science', acc: dyson.accumulated.science, tgt: dyson.target.science, color: '#6ee7b7' },
  ];

  return (
    <div className="settlements-section" data-tutorial-id="dyson-sphere-section" style={{ marginTop: 12 }}>
      <div className="section-title" style={{ color: '#ffb84d' }}>
        DYSON SPHERE
      </div>
      <div style={{
        fontSize: 10, marginBottom: 6,
        color: isMine ? '#6ee7b7' : '#ff8a4d',
      }}>
        {isMine ? '★ YOUR PROJECT' : `RIVAL: ${controller?.name ?? '?'}`}
        {station && <span style={{ color: '#a8b8c8' }}> · foundation: {station.name}</span>}
      </div>

      {/* Overall HP / progress bar */}
      <div style={{
        height: 10, background: 'rgba(42, 61, 80, 0.6)',
        borderRadius: 4, overflow: 'hidden', marginBottom: 4,
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, pct)}%`,
          background: 'linear-gradient(90deg, #ffb84d, #ffd180)',
          transition: 'width 0.3s ease',
        }} />
      </div>
      <div style={{ fontSize: 10, color: '#a8b8c8', marginBottom: 8, letterSpacing: '0.05em' }}>
        {Math.round(dyson.hp)} / {dyson.maxHp} HP · {pct.toFixed(1)}%
      </div>

      {/* Per-resource breakdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {rows.map(r => {
          const rowPct = r.tgt > 0 ? (r.acc / r.tgt) * 100 : 0;
          return (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9 }}>
              <span style={{ minWidth: 50, color: r.color }}>{r.label}</span>
              <div style={{
                flex: 1, height: 5, background: 'rgba(42, 61, 80, 0.6)',
                borderRadius: 2, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', width: `${Math.min(100, rowPct)}%`,
                  background: r.color, opacity: 0.85,
                }} />
              </div>
              <span style={{ minWidth: 96, textAlign: 'right', color: '#a8b8c8', letterSpacing: '0.04em' }}>
                {Math.round(r.acc).toLocaleString()} / {r.tgt.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      {isMine && (
        <div style={{
          marginTop: 8, fontSize: 9, color: '#a8b8c8', fontStyle: 'italic', lineHeight: 1.4,
        }}>
          Park more freighters at Sol to speed delivery. Each one drains
          your pool by 5F · 10O · 10C · 5S per tick. Foundation
          destruction wipes everything — defend it.
        </div>
      )}
    </div>
  );
};
