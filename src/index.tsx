import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { StagingBanner } from './components/StagingBanner';
import { AndroidBackHandler } from './platform/AndroidBackHandler';
import { registerServiceWorker } from './platform/registerSW';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    {/* ABOVE App, not inside it: App returns early for the landing
        page, the doc routes and the icon gallery, so a banner mounted
        in any one branch is invisible in the others — which is exactly
        how you end up staring at the marketing page of the wrong
        environment. Renders nothing in production. */}
    <StagingBanner />
    {/* Hardware back closes the top panel instead of the whole app.
        Renders nothing, and opts out entirely in a browser tab. */}
    <AndroidBackHandler />
    <App />
  </React.StrictMode>
);

// AFTER render, never before: registration competes for the main thread
// with the first paint, and the first paint of a strategy map is the
// thing a player is waiting for. Nothing above depends on it.
registerServiceWorker();
