import React, { useEffect, useState } from 'react';
import { GameContextProvider, useGameContext } from './state/gameContext';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { BodyInspector } from './components/BodyInspector';
import { ScenarioSelector } from './components/ScenarioSelector';
import './App.css';

const SIM_SPEEDS = [0, 1, 10, 100, 1000, 10000];

function AppContent() {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const { gameState, simSpeed, setSimSpeed, updateTick } = useGameContext();

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const cycleSpeed = () => {
    const idx = SIM_SPEEDS.indexOf(simSpeed);
    const next = SIM_SPEEDS[(idx + 1) % SIM_SPEEDS.length];
    setSimSpeed(next);
  };

  const handleSkipTick = () => {
    updateTick(gameState.currentTick + 10);
  };

  return (
    <div className="app">
      <MapCanvas width={windowSize.width} height={windowSize.height} />
      <ShipPanel />
      <BodyInspector />
      <ScenarioSelector />

      <div style={{
        position: 'fixed', bottom: 20, right: 20,
        display: 'flex', gap: '8px', zIndex: 1000,
      }}>
        <button onClick={cycleSpeed} style={btnStyle}>
          {simSpeed === 0 ? '▶ PLAY' : `${simSpeed}×`}
        </button>
        <button onClick={() => setSimSpeed(0)} style={btnStyle} disabled={simSpeed === 0}>
          ⏸ PAUSE
        </button>
        <button onClick={handleSkipTick} style={btnStyle}>
          ⏭ +10
        </button>
      </div>

      <div className="hud-title">
        <div className="title">ORBITAL</div>
        <div className="subtitle">BEZIER TRANSFER PROTOTYPE</div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 14px',
  backgroundColor: 'rgba(10, 14, 20, 0.9)',
  color: '#ffb84d',
  border: '1px solid #ffb84d',
  borderRadius: '4px',
  fontFamily: "'JetBrains Mono', monospace",
  cursor: 'pointer',
  fontSize: '11px',
  fontWeight: 'bold',
  letterSpacing: '0.05em',
};

export function App() {
  return (
    <GameContextProvider initialScenario={1}>
      <AppContent />
    </GameContextProvider>
  );
}

export default App;
