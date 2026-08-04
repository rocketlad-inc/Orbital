import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';

// Links the player's Orbital account to their Discord user, so Senate
// votes, alerts and trade offers reach them there.
//
// TWO PATHS, and the order matters:
//   1. Connect Discord (OAuth) — one click, no typing. Everyone should
//      take this one.
//   2. A pairing code — the fallback.
//
// The code path used to be the ONLY path, and it quietly didn't work:
// this component offered a "copy /link ABC123" button, but Discord slash
// commands are not text. Pasting that string posts a plain message and
// nothing happens — you have to type "/link", pick it from the
// autocomplete, and only THEN paste the code into the option field.
// Every player hit it. The code is now copied on its OWN, so what lands
// on the clipboard is exactly what goes in the box.

export const DiscordLink: React.FC = () => {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [oauth, setOauth] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await apiFetch<{
      linked: boolean; discord_username: string | null; oauth_available?: boolean;
    }>('/api/discord/link-status');
    if (res.ok) {
      setLinked(res.data.linked);
      setUsername(res.data.discord_username);
      setOauth(!!res.data.oauth_available);
    } else setLinked(false);
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Re-check when the tab regains focus: the OAuth callback finishes on
  // its own page, and players usually come straight back here.
  useEffect(() => {
    const onFocus = () => loadStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadStatus]);

  const mintCode = async () => {
    setBusy(true);
    const res = await apiFetch<{ code: string }>('/api/discord/link-code', { method: 'POST' });
    setBusy(false);
    if (res.ok) { setCode(res.data.code); setCopied(false); setShowCode(true); }
  };

  const unlink = async () => {
    setBusy(true);
    await apiFetch('/api/discord/unlink', { method: 'POST' });
    setBusy(false);
    setCode(null);
    setShowCode(false);
    loadStatus();
  };

  // Copy the CODE ALONE, never "/link CODE" — see the note above.
  const copyCode = () => {
    if (!code) return;
    navigator.clipboard?.writeText(code).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => { /* clipboard blocked — the code is on screen to type */ },
    );
  };

  if (linked === null) return null;

  return (
    <div className="discord-link">
      <div className="mp-section-title">Discord</div>

      {linked ? (
        <div className="discord-link__status">
          <span>🔗 Linked{username ? ` as ${username}` : ''} — votes, alerts and trades reach you there.</span>
          <button className="mp-btn mp-btn--ghost" onClick={unlink} disabled={busy}>Unlink</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {oauth && (
            <>
              <a
                className="mp-btn mp-btn--primary"
                href="/api/discord/oauth/start"
                style={{ textAlign: 'center', textDecoration: 'none' }}
              >
                Connect Discord
              </a>
              <div style={{ fontSize: 12, color: '#8a9fb3' }}>
                One click — approve on Discord and you're done. No code to type.
              </div>
            </>
          )}

          {!showCode ? (
            <button
              className={oauth ? 'mp-btn mp-btn--ghost' : 'mp-btn'}
              onClick={mintCode}
              disabled={busy}
              style={{ fontSize: 12 }}
            >
              {busy ? '…' : oauth ? 'Use a code instead' : 'Get a pairing code'}
            </button>
          ) : (
            <div style={{
              border: '1px solid rgba(96,130,160,.3)', borderRadius: 8, padding: '12px 14px',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ fontSize: 12, color: '#8a9fb3', lineHeight: 1.5 }}>
                In Discord, <b style={{ color: '#cdd9e4' }}>type <code>/link</code> and pick it from
                the menu</b> that pops up — pasting the whole command won't work. Then paste this
                code into the <code>code</code> box:
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{
                  fontSize: 19, letterSpacing: '.16em', color: '#4ecdc4',
                  background: 'rgba(78,205,196,.08)', padding: '7px 12px', borderRadius: 6,
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                }}>{code}</code>
                <button className="mp-btn mp-btn--ghost" onClick={copyCode} disabled={!code}>
                  {copied ? 'Copied ✓' : 'Copy code'}
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: '#5f7186' }}>
                Expires in 10 minutes.{' '}
                <button
                  onClick={mintCode}
                  disabled={busy}
                  style={{
                    background: 'none', border: 'none', color: '#4ecdc4', cursor: 'pointer',
                    padding: 0, font: 'inherit', textDecoration: 'underline',
                  }}
                >Get a new one</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
