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

function AppContent() {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const { gameState, updateTick } = useGameContext();

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

  const handleSkipTick = () => {
    updateTick(gameState.currentTick + 1);
  };

  return (
    <div className="app">
      <MapCanvas width={windowSize.width} height={windowSize.height} />
      <ShipPanel />
      <BodyInspector />
      <ScenarioSelector />
      <button
        onClick={handleSkipTick}
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          padding: '10px 20px',
          backgroundColor: '#ffb84d',
          color: '#0a0e14',
          border: 'none',
          borderRadius: '4px',
          fontFamily: 'monospace',
          cursor: 'pointer',
          zIndex: 1000,
          fontSize: '12px',
          fontWeight: 'bold',
        }}
        title="Skip to next tick (Tick: {gameState.currentTick})"
      >
        SKIP TICK
      </button>
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
