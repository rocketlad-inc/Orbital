// ============================================================
// VersionBanner
//
// Always-on tiny SHA badge in the bottom-left corner showing which
// build the user's tab is actually running. Polls /api/_version every
// 5 minutes (and once on focus) to compare with the SHA baked into
// this bundle at build time. If they differ, an amber banner appears
// across the top urging a hard reload.
//
// Cheap on the request budget (a sliver of the existing /state
// polling), and the only thing that catches "Ben has the tab open
// from yesterday's build and is reporting bugs that were already
// fixed."
// ============================================================

import React, { useEffect, useState, useCallback } from 'react';
import { GIT_SHA, BUILT_AT } from '../_version';
import { t } from '../i18n/core';
import { tRich } from '../i18n/rich';
import { useI18n } from '../i18n/react';
import './VersionBanner.css';

interface VersionResponse {
  git_sha?: string;
  built_at?: string;
}

const POLL_MS = 5 * 60 * 1000;  // 5 minutes
const SHORT = (sha: string) => sha.slice(0, 7);

export const VersionBanner: React.FC = () => {
  useI18n();
  const [serverSha, setServerSha] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const probe = useCallback(async () => {
    try {
      // cache:'no-store' is the whole point — we want to defeat any
      // intermediary caching of /api/_version so the comparison stays
      // honest after a deploy.
      const res = await fetch('/api/_version', { cache: 'no-store', credentials: 'include' });
      if (!res.ok) return;
      const json = (await res.json()) as VersionResponse;
      if (typeof json.git_sha === 'string') setServerSha(json.git_sha);
    } catch { /* network blip — silent, retry on next interval */ }
  }, []);

  useEffect(() => {
    probe();
    const id = setInterval(probe, POLL_MS);
    const onFocus = () => probe();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [probe]);

  // A new banner unblocks the dismiss when the version changes again.
  useEffect(() => {
    if (!serverSha || serverSha === GIT_SHA) return;
    setDismissed(false);
  }, [serverSha]);

  const mismatch = serverSha != null && serverSha !== GIT_SHA;

  return (
    <>
      {/* Corner SHA badge — always visible. Bottom-left so it doesn't fight
          the resource pills or outliner. Click to copy (desktop). Where
          the phone's bottom rail is, it sits ABOVE the rail and takes no
          taps: it used to lie on the rail's first button, so a tap meant
          for the menu copied the build number instead (playtester).
          Placement lives in VersionBanner.css. */}
      <div
        className={`version-badge${mismatch ? ' version-badge--stale' : ''}`}
        title={`${t('banner.build', { sha: GIT_SHA })}\n${BUILT_AT}\n${mismatch ? t('banner.stale') : t('banner.upToDate')}`}
        onClick={() => {
          try { navigator.clipboard.writeText(GIT_SHA); } catch { /* ignore */ }
        }}
      >
        v{SHORT(GIT_SHA)}{mismatch && serverSha ? ` → ${SHORT(serverSha)}` : ''}
      </div>

      {/* Center-screen banner — only when the server is genuinely newer.
          Pulled out of the top strip because it was overlapping the
          TopBar resource pills and nav buttons (playtester noted the
          collision). Centered as a floating chip so it's unambiguous
          and dismissible (a hard reload would replace it anyway). */}
      {mismatch && !dismissed && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 10001,
            background: 'rgba(10, 14, 20, 0.96)',
            border: '1px solid #ffb84d',
            borderRadius: 6,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.55), 0 0 24px rgba(255, 184, 77, 0.25)',
            color: '#ffb84d',
            padding: '14px 20px',
            fontFamily: 'var(--font-body, monospace)',
            fontSize: 13,
            letterSpacing: '0.04em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            maxWidth: 'min(520px, calc(100vw - 32px))',
            backdropFilter: 'blur(8px)',
          }}
        >
          <span>
            {tRich('banner.newer', {
              mine: <strong>{SHORT(GIT_SHA)}</strong>,
              server: <strong>{SHORT(serverSha!)}</strong>,
            })}
          </span>
          <button
            onClick={() => {
              try {
                // Best-effort cache wipe before reload so we don't bounce.
                if ('caches' in window) {
                  caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
                }
              } catch { /* ignore */ }
              window.location.reload();
            }}
            style={{
              background: '#ffb84d',
              color: '#0a0e14',
              border: 'none',
              padding: '4px 12px',
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              borderRadius: 2,
            }}
          >
            {t('banner.reload')}
          </button>
          <button
            onClick={() => setDismissed(true)}
            style={{
              background: 'transparent',
              color: 'inherit',
              border: '1px solid rgba(255, 184, 77, 0.5)',
              padding: '4px 10px',
              fontFamily: 'inherit',
              fontSize: 11,
              cursor: 'pointer',
              borderRadius: 2,
            }}
            title={t('banner.dismiss')}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
};
