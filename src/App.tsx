// ============================================================
// App - Main application component
// ============================================================

import React, { useEffect, useState } from 'react';
import { GameContextProvider, useGameContext } from './state/gameContext';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { BodyInspector } from './components/BodyInspector';
import { ScenarioSelector } from './components/ScenarioSelector';
import './App.css';

const TIME_SPEEDS = [
  { speed: 0, label: 'PAUSE' },
  { speed: 1, label: '1x' },
  { speed: 10, label: '10x' },
  { speed: 100, label: '100x' },
  { speed: 1000, label: '1Kx' },
  { speed: 10000, label: '10Kx' },
];

function formatGameTime(tick: number): string {
  const totalHours = Math.floor(Math.max(0, tick));
  const day = Math.floor(totalHours / 24) + 1;
  const hour = totalHours % 24;
  const minute = Math.floor(Math.max(0, tick - totalHours) * 60);
  return `D${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatSpeed(speed: number): string {
  if (speed === 0) return 'PAUSED';
  if (speed >= 1000) return `${speed / 1000}Kx`;
  return `${speed}x`;
}

function AppContent() {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const { gameState, simSpeed, setSimSpeed } = useGameContext();

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="app">
      <MapCanvas width={windowSize.width} height={windowSize.height} />
      <ShipPanel />
      <BodyInspector />
      <ScenarioSelector />
      <div className="time-controls">
        {TIME_SPEEDS.map(({ speed, label }) => (
          <button
            key={speed}
            className={`time-btn${simSpeed === speed ? ' active' : ''}`}
            onClick={() => setSimSpeed(speed)}
          >
            {label}
          </button>
        ))}
        <span className="time-tick">
          {formatGameTime(gameState.currentTick)}
          {` | ${formatSpeed(simSpeed)}`}
        </span>
      </div>
      <div className="hud-title">
        <div className="title">ORBITAL</div>
        <div className="subtitle">REACT FRONTEND PROTOTYPE</div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <GameContextProvider initialScenario={1}>
      <AppContent />
    </GameContextProvider>
  );
}

export default App;
