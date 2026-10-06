// ============================================================
// DiscordServerFeed — "post this game in your own Discord server".
//
// A Commander's Commission feature (worker/gameFeed.js, YOUR OWN SERVER).
// One click for the host: Discord's own consent screen adds the bot and
// picks the channel, then they are back. This card is the whole in-game
// side, and it says something useful to EVERY player, because each of
// them is a different moment:
//
//   connected       everyone: where the feed posts, and a link to it.
//                   The host can change the channel or go back to the
//                   Orbital forum.
//   paused          the host's Commission is gone: posts are falling back
//                   to the Orbital forum, and it says so.
//   host, holds it  the Connect button and how it works, step by step.
//   host, doesn't   what it does, and the Commission that brings it.
//   player, host
//   doesn't hold    gift the Commission to the host: whoever wants the
//                   game in their group's Discord can make it happen.
//
// Commission rules (commission.ts): show the goods, every pitch
// dismisses for good, and no buy button where nothing can be sold.
// ============================================================

import React, { useEffect, useState } from 'react';
import { apiFetch, startCommissionCheckout } from './api';
import { canBuyHere, logCommission, COMMISSION_NAME, COMMISSION_PRICE, HOLDER_MARK } from './commission';
import type { FeedView } from './GameFeedSettings';

const PITCH_KEY = 'orbital.discordFeedPitch.dismissed';
const readDismissed = () => { try { return localStorage.getItem(PITCH_KEY) === '1'; } catch { return false; } };
const writeDismissed = () => { try { localStorage.setItem(PITCH_KEY, '1'); } catch { /* private window */ } };

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
  padding: '9px 10px', borderRadius: 7,
  border: '1px solid rgba(196, 162, 255, .35)', background: 'rgba(40, 28, 66, .35)',
};
const dim: React.CSSProperties = { color: '#8a9fb3', fontSize: 11, lineHeight: 1.45 };
const head: React.CSSProperties = { fontWeight: 700, color: '#d9c8ff', letterSpacing: '.03em' };
const btn = (primary: boolean): React.CSSProperties => ({
  alignSelf: 'flex-start', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
  padding: '5px 10px', borderRadius: 5,
  color: primary ? '#0b0718' : '#d9c8ff',
  background: primary ? '#c4a2ff' : 'transparent',
  border: `1px solid ${primary ? '#c4a2ff' : 'rgba(196,162,255,.45)'}`,
});
const link: React.CSSProperties = { color: '#4ecdc4', fontSize: 12 };

/** What the host's Connect does, in the order it happens. */
export const SERVER_FEED_STEPS: string[] = [
  'Press Connect your server. Discord opens in a new tab.',
  'Pick your server, then the channel the game should post in. A forum channel works best: '
    + 'the game gets one post there, like a thread of its own. You need Manage Server on that server.',
  'Press Authorize. You land on a "Connected" page, and Orbital says hello in that channel '
    + 'with a link your friends can use to join the game.',
];
export const SERVER_FEED_TIPS: string[] = [
  'Nothing arriving? Give the Orbital role permission to view the channel, send messages and '
    + 'create posts in it (Server Settings → Channels → your channel → Permissions).',
  'The level above still decides what posts: Headlines or Everything.',
  'Changing channel is the same button again. "Use the Orbital forum" puts it back.',
  'Players who link their Discord account (Link Discord, in Senate) can vote from Discord, '
    + 'and members of your server can get their alerts by DM.',
];

export const DiscordServerFeed: React.FC<{
  gameId: string;
  view: FeedView;
  onChange: (v: FeedView) => void;
}> = ({ gameId, view, onChange }) => {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sellable = canBuyHere();
  const server = view.server ?? null;
  const host = view.host_name ?? 'The host';

  // The host comes back from Discord's tab: pick up the new destination.
  useEffect(() => {
    const onFocus = async () => {
      const res = await apiFetch<FeedView>(`/api/games/${encodeURIComponent(gameId)}/feed`);
      if (res.ok) onChange(res.data);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [gameId, onChange]);

  const pitching = !server && !dismissed && !view.host_holds_commission;
  useEffect(() => { if (pitching) logCommission('discord-feed', 'view'); }, [pitching]);

  const connect = () => {
    window.open(`/api/games/${encodeURIComponent(gameId)}/feed/connect`, '_blank', 'noopener');
  };
  const disconnect = async () => {
    setBusy(true); setError(null);
    const res = await apiFetch<FeedView>(`/api/games/${encodeURIComponent(gameId)}/feed/server`, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) onChange(res.data); else setError(res.error?.message ?? 'Could not change it');
  };
  const buy = async (gift: boolean) => {
    logCommission('discord-feed', 'click');
    const url = await startCommissionCheckout('discord-feed', { gift });
    if (url) window.location.assign(url);
    else setError('Could not start checkout. Try again from your profile.');
  };
  const dismiss = () => { logCommission('discord-feed', 'dismiss'); writeDismissed(); setDismissed(true); };

  const howTo = (
    <details data-testid="server-feed-howto">
      <summary style={{ ...dim, cursor: 'pointer', color: '#b7a3e6' }}>How it works</summary>
      <ol style={{ ...dim, margin: '4px 0 2px', paddingLeft: 18 }}>
        {SERVER_FEED_STEPS.map(s => <li key={s}>{s}</li>)}
      </ol>
      <ul style={{ ...dim, margin: '2px 0', paddingLeft: 18 }}>
        {SERVER_FEED_TIPS.map(s => <li key={s}>{s}</li>)}
      </ul>
    </details>
  );

  // ---- connected (or paused) ----------------------------------------------------
  if (server) {
    const where = `#${server.channel_name ?? 'channel'}${server.guild_name ? ` in ${server.guild_name}` : ''}`;
    return (
      <div style={card} data-testid="server-feed">
        <span style={head}>{HOLDER_MARK} Posting to {where}</span>
        {server.active ? (
          <span style={dim}>
            This game&apos;s feed goes to {server.kind === 'forum' ? 'its own post in that forum' : 'that channel'},
            {' '}courtesy of {host}&apos;s {COMMISSION_NAME}.
          </span>
        ) : (
          <span style={{ ...dim, color: '#ffb84d' }} data-testid="server-feed-paused">
            Paused: it needs {host}&apos;s {COMMISSION_NAME}. Until then the game posts to the Orbital forum.
          </span>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {server.url && <a href={server.url} target="_blank" rel="noreferrer" style={link}>Open in Discord</a>}
          {view.is_host && (
            <>
              <button type="button" style={btn(false)} disabled={busy} onClick={connect}>Change channel</button>
              <button type="button" style={btn(false)} disabled={busy} onClick={() => void disconnect()}
                data-testid="server-feed-disconnect">Use the Orbital forum</button>
            </>
          )}
        </div>
        {view.is_host && howTo}
        {error && <span style={{ ...dim, color: '#ff8a8a' }}>{error}</span>}
      </div>
    );
  }

  // ---- the host holds the Commission: connect ---------------------------------
  if (view.is_host && view.host_holds_commission) {
    return (
      <div style={card} data-testid="server-feed">
        <span style={head}>{HOLDER_MARK} Post this game in your own Discord server</span>
        <span style={dim}>
          Wars, battles, Senate votes and the daily Herald, in a channel your group already reads,
          with a link that lets your friends join the game.
        </span>
        {view.server_connect_ready === false ? (
          <span style={{ ...dim, color: '#ffb84d' }}>Orbital&apos;s Discord bot is not set up yet. Check back soon.</span>
        ) : (
          <button type="button" style={btn(true)} onClick={connect} data-testid="server-feed-connect">
            Connect your server
          </button>
        )}
        {howTo}
      </div>
    );
  }

  // ---- another player, and the host holds it: tell them it exists -------------------
  if (!view.is_host && view.host_holds_commission) {
    return (
      <div style={{ ...dim }} data-testid="server-feed-ask">
        {HOLDER_MARK} {host} can send this game&apos;s feed to your group&apos;s own Discord server
        from these settings.
      </div>
    );
  }

  // ---- nobody here holds it: the pitch (host) or the gift (player) ---------------
  if (!pitching) return null;
  return (
    <div style={card} data-testid={view.is_host ? 'server-feed-pitch' : 'server-feed-gift'}>
      <span style={head}>{HOLDER_MARK} Your game, in your Discord</span>
      <span style={dim}>
        Send this game&apos;s wars, battles, Senate votes and the daily Herald to a channel on
        {view.is_host ? ' your own server' : ' your group’s server'}, with a link that lets friends join.
        {' '}It comes with the {COMMISSION_NAME}: {COMMISSION_PRICE}, once.
        {view.is_host ? '' : ` ${host} hosts this game, so the Commission has to be theirs: you can gift it.`}
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {sellable ? (
          <button type="button" style={btn(true)} onClick={() => void buy(!view.is_host)}
            data-testid="server-feed-buy">
            {view.is_host ? `Get the Commission · ${COMMISSION_PRICE}` : `Gift it to ${host} · ${COMMISSION_PRICE}`}
          </button>
        ) : (
          <span style={dim}>Get it on the Orbital website; it unlocks here at your next sign-in.</span>
        )}
        <button type="button" style={{ ...btn(false), border: 'none', padding: '5px 4px' }} onClick={dismiss}>
          Not now
        </button>
      </div>
      {error && <span style={{ ...dim, color: '#ff8a8a' }}>{error}</span>}
    </div>
  );
};
