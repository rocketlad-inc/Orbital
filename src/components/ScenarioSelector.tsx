// ============================================================
// Scenario Selector - Switch between demo scenarios
// ============================================================

import React from 'react';
import { useGameContext } from '../state/gameContext';
import { SCENARIO_DESCRIPTIONS, ScenarioType } from '../state/mockGameState';
import './ScenarioSelector.css';

export const ScenarioSelector: React.FC = () => {
  const { loadScenario } = useGameContext();

  const handleSelectScenario = (scenario: ScenarioType) => {
    loadScenario(scenario);
  };

  return (
    <div className="scenario-selector">
      <div className="scenario-header">SELECT SCENARIO</div>
      <div className="scenario-list">
        {[1, 2, 3].map((num) => (
          <button
            key={num}
            className="scenario-btn"
            onClick={() => handleSelectScenario(num as ScenarioType)}
          >
            <div className="scenario-num">#{num}</div>
            <div className="scenario-desc">{SCENARIO_DESCRIPTIONS[num as ScenarioType]}</div>
          </button>
        ))}
      </div>
    </div>
  );
};
