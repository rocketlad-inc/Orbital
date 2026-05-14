// ============================================================
// BodyInspector - Resource readout for selected body
// ============================================================

import React from 'react';
import { useGameContext } from '../state/gameContext';
import './BodyInspector.css';

export const BodyInspector: React.FC = () => {
  const { gameState, uiState, deselectBody } = useGameContext();

  if (!uiState.selectedBodyId) {
    return null;
  }

  const body = gameState.bodies.find(b => b.id === uiState.selectedBodyId);
  if (!body || !body.resources) {
    return null;
  }

  return (
    <div className="body-inspector">
      <div className="panel-header">
        <span>{body.name.toUpperCase()}</span>
        <button className="panel-close" onClick={deselectBody}>
          ✕
        </button>
      </div>

      <div className="panel-body">
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

        <div className="body-info">
          <div className="info-row">
            <span className="label">TYPE</span>
            <span className="value">{body.type.toUpperCase()}</span>
          </div>
          {body.parent && (
            <div className="info-row">
              <span className="label">PARENT</span>
              <span className="value">{body.parent.toUpperCase()}</span>
            </div>
          )}
          <div className="info-row">
            <span className="label">ORBIT RADIUS</span>
            <span className="value">{body.orbitRadius}</span>
          </div>
          <div className="info-row">
            <span className="label">SOI</span>
            <span className="value">{body.soi}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
