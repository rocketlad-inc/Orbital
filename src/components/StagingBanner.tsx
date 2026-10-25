// ============================================================
// StagingBanner — you are not looking at the real game.
//
// Staging runs the same code against a different database, which is
// exactly what makes it useful and exactly what makes it dangerous: the
// two sites are pixel-identical, so the only thing stopping somebody
// from testing a destructive flow against real players' games is
// remembering which tab they are in. A stripe across the top is cheap
// insurance against an expensive mistake.
//
// It asks the SERVER rather than checking the hostname, because the
// hostname is the thing most likely to change (a custom domain, a
// preview URL, a local port) and the server is the thing that actually
// knows which database it is bound to.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import './StagingBanner.css';

export const StagingBanner: React.FC = () => {
  const [env, setEnv] = useState<string | null>(null);
  const [sha, setSha] = useState<string>('');

  useEffect(() => {
    let live = true;
    fetch('/api/_version')
      .then(r => r.json())
      .then(j => {
        if (!live) return;
        setEnv(j?.env ?? 'production');
        setSha(String(j?.git_sha ?? '').slice(0, 7));
      })
      // A failed probe must not paint a banner: claiming "staging" on
      // the real site would be worse than saying nothing at all.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // THE TOP BAR MAKES ROOM FOR THE BANNER. The banner sits over the top of
  // the page and the bar is fixed at the top, so on a phone the resource
  // pills sat under the stripes (Maya, 2026-10-24). Publishing the
  // banner's height as --stg-h grows --topbar-h by it (App.css), and every
  // panel anchored under the bar follows. Production never renders this,
  // so --stg-h is never set there and the layout is unchanged.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (env !== 'staging' || !el) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--stg-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--stg-h'); };
  }, [env]);

  if (env !== 'staging') return null;

  return (
    <div className="stg-banner" role="status" ref={ref}>
      <span className="stg-dot" aria-hidden />
      <b>STAGING</b>
      <span className="stg-sep">·</span>
      <span>separate database — nothing here affects a live game</span>
      {sha && <span className="stg-sha">{sha}</span>}
    </div>
  );
};

export default StagingBanner;
