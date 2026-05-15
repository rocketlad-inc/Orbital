// ============================================================
// Scenario Selector - Switch between demo scenarios
// ============================================================

import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { SCENARIO_DESCRIPTIONS, ScenarioType } from '../state/mockGameState';
import './ScenarioSelector.css';

export const ScenarioSelector: React.FC = () => {
  const { loadScenario } = useGameContext();
  const [expanded, setExpanded] = useState(true);
  const [activeScenario, setActiveScenario] = useState<ScenarioType>(1);

  const handleSelectScenario = (scenario: ScenarioType) => {
    loadScenario(scenario);
    setActiveScenario(scenario);
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <button
        className="scenario-chip"
        onClick={() => setExpanded(true)}
        title="Switch scenario"
      >
        SCENARIO #{activeScenario}
      </button>
    );
  }

  return (
    <div className="scenario-selector">
      <div className="scenario-header">
        <span>SELECT SCENARIO</span>
        <button
          className="scenario-collapse"
          onClick={() => setExpanded(false)}
          title="Collapse"
        >
          –
        </button>
      </div>
      <div className="scenario-list">
        {[1, 2, 3, 4].map((num) => (
          <button
            key={num}
            className={`scenario-btn ${activeScenario === num ? 'active' : ''}`}
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
