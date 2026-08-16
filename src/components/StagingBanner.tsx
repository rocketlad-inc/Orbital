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

import React, { useEffect, useState } from 'react';
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

  if (env !== 'staging') return null;

  return (
    <div className="stg-banner" role="status">
      <span className="stg-dot" aria-hidden />
      <b>STAGING</b>
      <span className="stg-sep">·</span>
      <span>separate database — nothing here affects a live game</span>
      {sha && <span className="stg-sha">{sha}</span>}
    </div>
  );
};

export default StagingBanner;
