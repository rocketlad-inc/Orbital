import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { StagingBanner } from './components/StagingBanner';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    {/* ABOVE App, not inside it: App returns early for the landing
        page, the doc routes and the icon gallery, so a banner mounted
        in any one branch is invisible in the others — which is exactly
        how you end up staring at the marketing page of the wrong
        environment. Renders nothing in production. */}
    <StagingBanner />
    <App />
  </React.StrictMode>
);
