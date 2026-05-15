import React, { useEffect, useState } from 'react';
import { GameContextProvider } from './state/gameContext';
import { MapCanvas } from './components/MapCanvas';
import { ShipPanel } from './components/ShipPanel';
import { BodyInspector } from './components/BodyInspector';
import { ScenarioSelector } from './components/ScenarioSelector';
import { TopBar, PanelId } from './components/TopBar';
import { Outliner } from './components/Outliner';
import { SettlementsPanel } from './components/SettlementsPanel';
import { FleetPanel } from './components/FleetPanel';
import './App.css';

function AppContent() {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });
  const [activePanel, setActivePanel] = useState<PanelId>(null);

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Skip if user is typing in an input
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (e.key === 'Escape') setActivePanel(null);
      if (e.key === 's' || e.key === 'S') setActivePanel(p => (p === 'settlements' ? null : 'settlements'));
      if (e.key === 'f' || e.key === 'F') setActivePanel(p => (p === 'fleet' ? null : 'fleet'));
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="app">
      <MapCanvas width={windowSize.width} height={windowSize.height} />

      <TopBar activePanel={activePanel} onTogglePanel={setActivePanel} />
      <Outliner />

      {activePanel === 'settlements' && (
        <SettlementsPanel onClose={() => setActivePanel(null)} />
      )}
      {activePanel === 'fleet' && (
        <FleetPanel onClose={() => setActivePanel(null)} />
      )}

      <ShipPanel />
      <BodyInspector />
      <ScenarioSelector />
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
