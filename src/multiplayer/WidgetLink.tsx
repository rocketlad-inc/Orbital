// ============================================================
// WidgetLink — the link that feeds a home-screen widget.
//
// The card itself is rendered entirely on the server (worker/widget.js):
// this component only mints, shows and revokes the token that addresses
// it. That split is deliberate — the Android widget is the one surface a
// Worker deploy cannot change, so everything that might ever need
// changing lives in the image.
//
// THE URL IS A CREDENTIAL and the copy says so. Anyone holding it can
// see your resource counts and what is waiting on you. It cannot issue
// orders, read messages, or be traded for a session, but it is still not
// a link to paste in a public channel, and a player who does not know
// that will paste it in a public channel.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';

type Token = { token: string; label: string | null; created_ms: number; last_used_ms: number | null };

export function WidgetLink() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch<{ tokens: Token[] }>('/api/me/widget-tokens');
    if (res.ok) { setTokens(res.data.tokens); setErr(null); }
    else setErr('Could not load your widget links.');
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true); setErr(null);
    const res = await apiFetch<{ token: string }>('/api/me/widget-tokens', {
      method: 'POST', body: JSON.stringify({ label: 'phone' }),
    });
    setBusy(false);
    if (res.ok) await load();
    else setErr('Could not create a widget link.');
  };

  const revoke = async (token: string) => {
    setBusy(true); setErr(null);
    const res = await apiFetch<{ revoked: boolean }>('/api/me/widget-tokens/revoke', {
      method: 'POST', body: JSON.stringify({ token }),
    });
    setBusy(false);
    if (res.ok) await load();
    else setErr('Could not revoke that link.');
  };

  if (tokens === null) return null;
  const current = tokens[0] ?? null;
  const url = current ? `${window.location.origin}/widget/${current.token}.png` : '';

  return (
    <div style={{ marginTop: 18 }}>
      <div style={head}>Home screen widget</div>
      <div style={sub}>
        A picture of your empire — resources, the tick clock, and anything waiting on
        you — that updates on its own.
      </div>

      {err && <div style={{ ...sub, color: '#ffca28', marginTop: 6 }}>{err}</div>}

      {!current ? (
        <button type="button" onClick={create} disabled={busy}
          style={{ ...pill, marginTop: 10, padding: '6px 12px', opacity: busy ? 0.5 : 1 }}
        >Create a widget link</button>
      ) : (
        <>
          {/* The card itself, live. Nothing explains what this is faster
              than the actual image, and it doubles as proof the link
              works before anyone puts it on a home screen. */}
          <img
            src={url}
            alt="Your Orbital status card"
            style={{
              display: 'block', width: '100%', maxWidth: 420, marginTop: 10,
              borderRadius: 8, border: '1px solid rgba(96,130,160,.28)',
            }}
          />

          <div style={{
            marginTop: 8, fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
            fontSize: 10.5, color: '#8a9fb3', wordBreak: 'break-all',
            background: 'rgba(20,32,46,.5)', border: '1px solid rgba(96,130,160,.22)',
            borderRadius: 6, padding: '7px 9px',
          }}>{url}</div>

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                } catch {
                  // Clipboard access is refused often enough (insecure
                  // context, permissions) that failing silently would
                  // read as a dead button. The URL is on screen anyway.
                  setErr('Could not copy — select the link above instead.');
                }
              }}
              style={{ ...pill, padding: '6px 12px', borderColor: '#4ecdc4', color: '#4ecdc4' }}
            >{copied ? 'Copied' : 'Copy link'}</button>
            <button type="button" onClick={() => revoke(current.token)} disabled={busy}
              style={{ ...pill, padding: '6px 12px', opacity: busy ? 0.5 : 1 }}
            >Revoke</button>
          </div>

          <div style={{ ...sub, marginTop: 8 }}>
            Treat this like a password. Anyone with the link can see this card — your
            resources and what is waiting on you. They cannot give orders, read your
            messages, or sign in as you. Revoking it stops it immediately.
          </div>
        </>
      )}
    </div>
  );
}

const head: React.CSSProperties = {
  fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase',
  color: '#7fd8cf', marginBottom: 8, fontWeight: 700,
};
const sub: React.CSSProperties = { fontSize: 12, color: '#8a9fb3', lineHeight: 1.5 };
const pill: React.CSSProperties = {
  background: 'transparent', border: '1px solid rgba(96,130,160,.45)',
  borderRadius: 999, color: '#cdd9e4', cursor: 'pointer', fontSize: 11.5,
};
