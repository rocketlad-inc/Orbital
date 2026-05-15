import React, { useEffect, useState } from 'react';
import { GameContextProvider, useGameContext } from './state/gameContext';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { BodyInspector } from './components/BodyInspector';
import { ScenarioSelector } from './components/ScenarioSelector';
import './App.css';

const SIM_SPEEDS = [0, 1, 10, 100, 1000, 10000, 100000];

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

  const skipTicks = (n: number) => {
    updateTick(gameState.currentTick + n);
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
        <button onClick={cycleSpeed} style={btnStyle} title="Cycle simulation speed">
          {simSpeed === 0 ? '▶ PLAY' : `${simSpeed.toLocaleString()}×`}
        </button>
        <button onClick={() => setSimSpeed(0)} style={btnStyle} disabled={simSpeed === 0} title="Pause">
          ⏸ PAUSE
        </button>
        <button onClick={() => skipTicks(10)} style={btnStyle} title="Skip 10 ticks">
          ⏭ +10
        </button>
        <button onClick={() => skipTicks(100)} style={btnStyle} title="Skip 100 ticks">
          ⏭⏭ +100
        </button>
        <button onClick={() => skipTicks(1000)} style={btnStyle} title="Skip 1,000 ticks">
          ⏭⏭⏭ +1K
        </button>
      </div>

      {/* Resource HUD */}
      {gameState.resources['player'] && (
        <div style={{
          position: 'fixed', top: 12, right: 20,
          display: 'flex', gap: '16px', zIndex: 1000,
          background: 'rgba(10, 14, 20, 0.9)',
          border: '1px solid #2a3d50',
          borderRadius: '4px',
          padding: '6px 14px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
        }}>
          <span style={{ color: '#ffb84d' }}>
            FUEL: <strong style={{ color: '#d8e4ee' }}>{gameState.resources['player'].fuel}</strong>
          </span>
          <span style={{ color: '#a0a0a0' }}>
            ORE: <strong style={{ color: '#d8e4ee' }}>{gameState.resources['player'].ore}</strong>
          </span>
          <span style={{ color: '#ffd700' }}>
            CR: <strong style={{ color: '#d8e4ee' }}>{gameState.resources['player'].credits}</strong>
          </span>
          <span style={{ color: '#6b8195' }}>
            SHIPS: <strong style={{ color: '#d8e4ee' }}>{gameState.ships.filter(s => s.ownedBy === 'player').length}</strong>
          </span>
        </div>
      )}

      {/* Combat Log */}
      {gameState.combatLog.length > 0 && (
        <div style={{
          position: 'fixed', top: 60, left: 20,
          width: '280px', maxHeight: '140px',
          overflow: 'auto', zIndex: 1000,
          background: 'rgba(10, 14, 20, 0.92)',
          border: '1px solid #ff5e5e',
          borderRadius: '4px',
          padding: '8px 12px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '10px',
          color: '#ff5e5e',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '4px', color: '#ffb84d', letterSpacing: '0.1em' }}>COMBAT LOG</div>
          {gameState.combatLog.slice(-5).map((msg, i) => (
            <div key={i}>{msg}</div>
          ))}
        </div>
      )}

      <div className="hud-title">
        <div className="title">ORBITAL</div>
        <div className="subtitle">SHIP SYSTEMS PROTOTYPE</div>
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
