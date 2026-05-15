// ============================================================
// BodyInspector - Resource readout + build UI for selected body
// ============================================================

import React from 'react';
import { useGameContext } from '../state/gameContext';
import { BuildPanel } from './BuildPanel';
import { bodyProductionRates } from '../game/economy';
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
          const freightersHere = gameState.ships.filter(
            s => s.class === 'freighter' && !s.transfer && s.orbit.parentBodyId === body.id
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
                  <div className="production-title">PRODUCTION / HARVEST</div>
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
                    {freightersHere.length > 0
                      ? `${freightersHere.length} freighter${freightersHere.length > 1 ? 's' : ''} harvesting (x${freightersHere.length})`
                      : 'No freighters — send one to harvest'}
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

        <BuildPanel />
      </div>
    </div>
  );
};
