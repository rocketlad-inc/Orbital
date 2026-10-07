// ============================================================
// GameFeedSettings — this game's Discord feed (worker/gameFeed.js).
//
// Each game posts into its own post in a Discord forum, and only when the
// HOST turns it on (Lorne, 2026-10-01). The host picks the level; anyone
// with a linked Discord account can follow, which asks the bot to add
// them to the game's post. Used in the lobby and in the in-game
// Notifications window.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';
import { DiscordServerFeed } from './DiscordServerFeed';
import { t, tk } from '../i18n/core';
import { apiErrorText } from '../i18n/apiErrors';
import { useI18n } from '../i18n/react';

export type FeedLevel = 'off' | 'headlines' | 'all';

export interface FeedView {
  level: FeedLevel;
  thread_url: string | null;
  following: boolean;
  discord_linked: boolean;
  forum_configured: boolean;
  is_host: boolean;
  /** The Orbital Discord server's invite; the feed's posts live there. */
  discord_invite?: string | null;
  /** The host's own Discord channel, when connected (a Commission
   *  feature, DiscordServerFeed). active=false: the host's Commission is
   *  gone and posts fall back to the Orbital forum. */
  server?: {
    guild_name: string | null;
    channel_name: string | null;
    kind: 'forum' | 'text';
    url: string | null;
    active: boolean;
  } | null;
  host_name?: string | null;
  i_hold_commission?: boolean;
  host_holds_commission?: boolean;
  /** False until the bot's client id/secret and token are set. */
  server_connect_ready?: boolean;
}

export const FEED_LEVEL_LABEL: Record<FeedLevel, string> = {
  off: 'Off',
  headlines: 'Headlines',
  all: 'Everything',
};

export const FEED_LEVEL_HINT: Record<FeedLevel, string> = {
  off: 'Nothing about this game is posted to Discord.',
  headlines: 'Wars declared and ended, chancellor votes, big battles and the daily Herald.',
  all: 'Everything: also every bill, law, chairman and battle.',
};

const box: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  padding: '10px 12px', border: '1px solid rgba(96,130,160,.3)', borderRadius: 8,
  background: 'rgba(14, 21, 30, .6)', fontSize: 12, color: '#c8d8e8',
};
const dim: React.CSSProperties = { color: '#8a9fb3', fontSize: 11, lineHeight: 1.45 };

export const GameFeedSettings: React.FC<{ gameId: string; title?: string }> = ({ gameId, title }) => {
  useI18n();
  const [view, setView] = useState<FeedView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<FeedView>(`/api/games/${encodeURIComponent(gameId)}/feed`);
    if (res.ok) setView(res.data);
  }, [gameId]);
  useEffect(() => { void load(); }, [load]);

  if (!view) return null;

  const setLevel = async (level: FeedLevel) => {
    setBusy(true); setError(null);
    const res = await apiFetch<FeedView>(`/api/games/${encodeURIComponent(gameId)}/feed`, {
      method: 'PUT', body: JSON.stringify({ level }),
    });
    setBusy(false);
    if (res.ok) setView(res.data); else setError(apiErrorText(res.error, 'mp.feed.errLevel'));
  };
  const setFollow = async (follow: boolean) => {
    setBusy(true); setError(null);
    const res = await apiFetch<FeedView>(`/api/games/${encodeURIComponent(gameId)}/feed/follow`, {
      method: 'POST', body: JSON.stringify({ follow }),
    });
    setBusy(false);
    if (res.ok) setView(res.data); else setError(apiErrorText(res.error, 'mp.feed.errFollow'));
  };

  const on = view.level !== 'off';
  // Posting to the host's own server: the Orbital forum's follow toggle,
  // invite and "forum not set up" warning are about somewhere else.
  const inOwnServer = !!view.server?.active;
  return (
    <div style={box} data-testid="game-feed-settings">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 700, letterSpacing: '.04em' }}>{title ?? t('mp.feed.title')}</span>
        {view.is_host ? (
          <select
            aria-label={t('mp.feed.ariaLabel')}
            data-testid="game-feed-level"
            value={view.level}
            disabled={busy}
            onChange={e => void setLevel(e.target.value as FeedLevel)}
            style={{
              background: '#070c12', color: on ? '#4ecdc4' : '#d6e2ec',
              border: `1px solid ${on ? '#2f6f6b' : '#2a3d50'}`, borderRadius: 4,
              fontFamily: 'inherit', fontSize: 12, padding: '4px 6px',
            }}
          >
            {(['off', 'headlines', 'all'] as FeedLevel[]).map(l => (
              <option key={l} value={l}>{tk(`mp.feed.level.${l}`, FEED_LEVEL_LABEL[l])}</option>
            ))}
          </select>
        ) : (
          <span style={{ color: on ? '#4ecdc4' : '#8a9fb3' }}>{tk(`mp.feed.level.${view.level}`, FEED_LEVEL_LABEL[view.level])}</span>
        )}
      </div>
      <div style={dim}>
        {tk(`mp.feed.hint.${view.level}`, FEED_LEVEL_HINT[view.level])}
        {view.is_host && !on && t('mp.feed.onlyHost')}
      </div>
      <DiscordServerFeed gameId={gameId} view={view} onChange={setView} />
      {on && !inOwnServer && !view.forum_configured && (
        <div style={{ ...dim, color: '#ffb84d' }}>
          {t('mp.feed.noForum')}
        </div>
      )}
      {on && !inOwnServer && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {view.discord_linked ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="game-feed-follow"
                checked={view.following}
                disabled={busy}
                onChange={e => void setFollow(e.target.checked)}
              />
              {t('mp.feed.follow')}
            </label>
          ) : (
            <span style={dim}>{t('mp.feed.linkFirst')}</span>
          )}
          {view.thread_url && (
            <a href={view.thread_url} target="_blank" rel="noreferrer" style={{ color: '#4ecdc4', fontSize: 12 }}>
              {t('mp.feed.openPost')}
            </a>
          )}
        </div>
      )}
      {view.discord_invite && !inOwnServer && (
        <div style={dim}>
          {t('mp.feed.notOn')}{' '}
          <a href={view.discord_invite} target="_blank" rel="noreferrer" data-testid="game-feed-invite"
            style={{ color: '#4ecdc4' }}>{t('mp.feed.join')}</a>
          {on ? t('mp.feed.seeFeed') : '.'}
        </div>
      )}
      {error && <div style={{ ...dim, color: '#ff8a8a' }}>{error}</div>}
    </div>
  );
};
