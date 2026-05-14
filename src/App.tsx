// ============================================================
// App - Main application component
// ============================================================

import React, { useEffect, useState } from 'react';
import { GameContextProvider } from './state/gameContext';
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
