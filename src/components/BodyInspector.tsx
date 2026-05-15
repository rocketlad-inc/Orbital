// ============================================================
// BodyInspector - Resource readout + build UI for selected body
// ============================================================

import React, { useState, useEffect, useRef } from 'react';
import { useGameContext } from '../state/gameContext';
import { BuildPanel } from './BuildPanel';
import { bodyProductionRates } from '../game/economy';
import {
  canHostCity, canHostStation, SETTLEMENT_DEFS, settlementYield, suggestSettlementName,
} from '../game/settlements';
import { SettlementType } from '../types';
import './BodyInspector.css';

export const BodyInspector: React.FC = () => {
  const { gameState, uiState, deselectBody } = useGameContext();

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
    s => !s.transfer && s.orbit.parentBodyId === body.id
  );

  return (
    <div className="body-inspector">
      <div className="panel-header">
        <span>{body.name.toUpperCase()}</span>
        <button className="panel-close" onClick={deselectBody}>
          ✕
        </button>
      </div>

      <div className="panel-body">
        {body.resources && (() => {
          const production = bodyProductionRates(body);
          const hasProduction = production.fuel > 0 || production.ore > 0 || production.credits > 0;
          const settlementsHere = gameState.settlements.filter(s => s.bodyId === body.id);
          const playerSettlements = settlementsHere.filter(s => s.ownedBy === 'player');
          const freightersHere = gameState.ships.filter(
            s => s.class === 'freighter' && !s.transfer && s.orbit.parentBodyId === body.id && s.ownedBy === 'player'
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
                <div className="production-summary">
                  <div className="production-title">POTENTIAL YIELD / HARVEST</div>
                  <div className="production-rates">
                    {production.fuel > 0 && (
                      <span className="production-rate">+{production.fuel} FUEL</span>
                    )}
                    {production.ore > 0 && (
                      <span className="production-rate">+{production.ore} ORE</span>
                    )}
                    {production.credits > 0 && (
                      <span className="production-rate">+{production.credits} CR</span>
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

        <SettlementsSection bodyId={body.id} />

        <BuildPanel />
      </div>
    </div>
  );
};

interface SettlementsSectionProps {
  bodyId: string;
}

const SettlementsSection: React.FC<SettlementsSectionProps> = ({ bodyId }) => {
  const {
    gameState, deploySettlement, selectSettlement, selectedSettlementId,
  } = useGameContext();

  // Inline name prompt state — when set, shows naming form for that type
  const [namingType, setNamingType] = useState<SettlementType | null>(null);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const body = gameState.bodies.find(b => b.id === bodyId);

  // Auto-focus and seed default name when prompt opens
  useEffect(() => {
    if (namingType && body) {
      setDraftName(suggestSettlementName(body, namingType, gameState.settlements));
      // Focus & select after a tick so the input is rendered
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [namingType, body, gameState.settlements]);

  if (!body) return null;

  const settlements = gameState.settlements.filter(s => s.bodyId === bodyId);

  const playerShipHere = gameState.ships.find(s =>
    s.ownedBy === 'player' && !s.transfer && s.orbit.parentBodyId === bodyId
  );
  const canBuildHere = !!playerShipHere;

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
    const name = draftName.trim();
    deploySettlement(bodyId, namingType, name || undefined);
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

        return (
          <div
            key={s.id}
            className={`settlement-row ${isSelected ? 'selected' : ''}`}
            onClick={() => selectSettlement(isSelected ? undefined : s.id)}
          >
            <div className="settlement-info">
              <div className="settlement-name" style={{ color: owner?.color }}>
                {s.type === 'city' ? '■' : '◆'} {s.name}
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
          <div className="deploy-buttons">
            {cityAllowed && (
              <button
                className="deploy-btn"
                disabled={!canBuildHere || !canAffordCity}
                onClick={() => handleStartDeploy('city')}
                title={
                  !canBuildHere ? 'Need a ship in orbit'
                  : !canAffordCity ? `Need ${SETTLEMENT_DEFS.city.cost.fuel}F/${SETTLEMENT_DEFS.city.cost.ore}O/${SETTLEMENT_DEFS.city.cost.credits}C`
                  : `Deploy a city (${SETTLEMENT_DEFS.city.cost.fuel}F/${SETTLEMENT_DEFS.city.cost.ore}O/${SETTLEMENT_DEFS.city.cost.credits}C)`
                }
              >
                ■ DEPLOY CITY
              </button>
            )}
            {stationAllowed && (
              <button
                className="deploy-btn"
                disabled={!canBuildHere || !canAffordStation}
                onClick={() => handleStartDeploy('station')}
                title={
                  !canBuildHere ? 'Need a ship in orbit'
                  : !canAffordStation ? `Need ${SETTLEMENT_DEFS.station.cost.fuel}F/${SETTLEMENT_DEFS.station.cost.ore}O/${SETTLEMENT_DEFS.station.cost.credits}C`
                  : `Deploy a station (${SETTLEMENT_DEFS.station.cost.fuel}F/${SETTLEMENT_DEFS.station.cost.ore}O/${SETTLEMENT_DEFS.station.cost.credits}C)`
                }
              >
                ◆ DEPLOY STATION
              </button>
            )}
          </div>

          {!canBuildHere && (cityAllowed || stationAllowed) && (
            <div className="deploy-hint">Send a ship to orbit to deploy</div>
          )}
        </>
      )}
    </div>
  );
};
