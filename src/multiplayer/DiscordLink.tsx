import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';

// Links the player's Orbital account to their Discord user so they can
// vote on Senate bills from the Discord vote cards. Flow: mint a code
// here -> run `/link <code>` in Discord -> the bot stores the mapping.
// See worker/discord.js. Endpoints are user-scoped (no gameId).

export const DiscordLink: React.FC = () => {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await apiFetch<{ linked: boolean; discord_username: string | null }>(
      '/api/discord/link-status',
    );
    if (res.ok) { setLinked(res.data.linked); setUsername(res.data.discord_username); }
    else setLinked(false);
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const mintCode = async () => {
    setBusy(true);
    const res = await apiFetch<{ code: string; command: string }>(
      '/api/discord/link-code', { method: 'POST' },
    );
    setBusy(false);
    if (res.ok) { setCode(res.data.code); setCopied(false); }
  };

  const unlink = async () => {
    setBusy(true);
    await apiFetch('/api/discord/unlink', { method: 'POST' });
    setBusy(false);
    setCode(null);
    loadStatus();
  };

  const copyCommand = () => {
    if (!code) return;
    navigator.clipboard?.writeText(`/link ${code}`).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => { /* clipboard blocked — the code is shown for manual entry */ },
    );
  };

  if (linked === null) return null; // status still loading

  return (
    <div className="discord-link">
      <div className="mp-section-title">Discord</div>
      {linked ? (
        <div className="discord-link__status">
          <span>🔗 Linked{username ? ` as ${username}` : ''} — vote on bills from Discord.</span>
          <button className="mp-btn mp-btn--ghost" onClick={unlink} disabled={busy}>Unlink</button>
        </div>
      ) : code ? (
        <div className="discord-link__code">
          <p className="discord-link__hint">In your server, run:</p>
          <button className="discord-link__cmd" onClick={copyCommand} title="Click to copy">
            <code>/link {code}</code>
            <span className="discord-link__copy">{copied ? 'copied ✓' : 'copy'}</span>
          </button>
          <p className="discord-link__hint discord-link__hint--dim">
            Code expires in 10 minutes. Once linked, click Yea/Nay/Abstain on any Senate vote card.
          </p>
        </div>
      ) : (
        <div className="discord-link__status">
          <span className="discord-link__hint">Vote on Senate bills straight from Discord.</span>
          <button className="mp-btn" onClick={mintCode} disabled={busy}>
            {busy ? '…' : 'Link Discord'}
          </button>
        </div>
      )}
    </div>
  );
};
