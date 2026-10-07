// ============================================================
// ProfilePanel — account, career and friends (migration 0073).
//
// One tab, three jobs, in the order a player cares about them:
//   1. who you are        — display name, editable
//   2. what you've done   — career totals + per-game history
//   3. who you play with  — friends, requests, and a search to add more
//
// Everything reads from /api/users/me/* ; nothing here is cached across
// mounts because a profile is opened rarely and stale friend counts are
// worse than a spinner.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';
import { CommissionThanks } from './CommissionThanks';
import { useAuth } from './AuthContext';
import { EmailSettings } from './EmailSettings';
import { Hangar } from './Hangar';
import { t, tn, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';

interface CareerProfile {
  display_name?: string;
  created_at?: number;
  renamed_ms?: number | null;
  games_played?: number;
  games_active?: number;
  wins?: number;
  ships_built?: number;
  ships_lost?: number;
  settlements_founded?: number;
  kills?: number;
  damage_dealt?: number;
  best_captain_rank?: number;
}

interface HistoryRow {
  game_id: string;
  room_name: string | null;
  status: string;
  current_tick: number;
  faction_name: string;
  won: number;
}

interface FriendRow {
  user_id: string;
  display_name: string;
  games_played: number;
  since: number;
}

export function ProfilePanel({ onEnterRoom }: { onEnterRoom?: (id: string) => void }) {
  useI18n();
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState<CareerProfile | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [incoming, setIncoming] = useState<FriendRow[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown over everything on the return trip from Stripe. Separate
  // from `notice` because a line of text is not what someone who has
  // just paid came back for.
  const [thanks, setThanks] = useState(false);
  // Back from buying a GIFT: the Hangar polls for the new code.
  const [giftBought, setGiftBought] = useState(false);

  // Consume Stripe's ?purchase=success|cancelled return trip. The param
  // is stripped from the URL immediately so a reload doesn't re-thank
  // (or re-apologise to) the player. On success the webhook may land a
  // beat after the redirect, so /me is refreshed twice: once now, once
  // a few seconds later — is_premium flips whenever the grant lands.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const outcome = q.get('purchase');
    if (!outcome) return;
    q.delete('purchase');
    const rest = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    if (outcome === 'success') {
      setThanks(true);
      // The overlay tells the story now, so the inline notice would only
      // be a second copy of it sitting behind the scrim.
      refresh();
      // Poll until the grant lands rather than guessing once. The webhook
      // is usually in before the redirect finishes, but it is a different
      // request on a different connection and nothing guarantees the
      // order — a single delayed refresh would leave the overlay stuck
      // "unlocking" for anyone it raced.
      let tries = 0;
      const iv = setInterval(() => {
        tries += 1;
        refresh();
        if (tries >= 10) clearInterval(iv);
      }, 2000);
      return () => clearInterval(iv);
    }
    if (outcome === 'gift') {
      // A gift buys nothing for the buyer: the Hangar shows the code to
      // pass on as soon as the webhook mints it.
      setGiftBought(true);
      setNotice(t('profile.notice.gift'));
    }
    if (outcome === 'cancelled') {
      setNotice(t('profile.notice.cancelled'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const p = await apiFetch<{ profile: CareerProfile; history: HistoryRow[] }>('/api/users/me/profile');
    if (p.ok) { setProfile(p.data.profile); setHistory(p.data.history ?? []); }
    const f = await apiFetch<{ friends: FriendRow[]; incoming: FriendRow[]; outgoing: FriendRow[] }>('/api/users/me/friends');
    if (f.ok) { setFriends(f.data.friends ?? []); setIncoming(f.data.incoming ?? []); setOutgoing(f.data.outgoing ?? []); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ---- rename ----
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const beginEdit = () => { setDraft(profile?.display_name ?? user?.display_name ?? ''); setEditing(true); setError(null); };
  const saveName = async () => {
    setSaving(true); setError(null);
    const res = await apiFetch<{ display_name: string }>('/api/users/me', {
      method: 'PATCH', body: JSON.stringify({ display_name: draft }),
    });
    setSaving(false);
    if (!res.ok) { setError(apiErrorText(res.error, 'profile.err.rename')); return; }
    setEditing(false);
    setNotice(t('profile.notice.renamed'));
    // The header and every lobby row read the auth user, so refresh it
    // rather than leaving two different names on screen.
    await refresh?.();
    load();
  };

  // ---- friends ----
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FriendRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const search = async () => {
    if (query.trim().length < 2) { setError(t('profile.err.short')); return; }
    setSearching(true); setError(null);
    const res = await apiFetch<{ players: Array<{ id: string; display_name: string; games_played: number }> }>(
      `/api/users/search?q=${encodeURIComponent(query.trim())}`,
    );
    setSearching(false);
    if (!res.ok) { setError(apiErrorText(res.error, 'profile.err.search')); return; }
    setResults(res.data.players.map(p => ({
      user_id: p.id, display_name: p.display_name, games_played: p.games_played, since: 0,
    })));
  };
  const act = async (path: string, method: string, msg: string) => {
    setError(null);
    const res = await apiFetch(path, { method });
    if (!res.ok) { setError(apiErrorText(res.error, 'profile.err.failed')); return; }
    setNotice(msg);
    setResults(null);
    setQuery('');
    load();
  };
  const addFriend = async (id: string, name: string) => {
    setError(null);
    const res = await apiFetch('/api/users/me/friends', {
      method: 'POST', body: JSON.stringify({ user_id: id }),
    });
    if (!res.ok) { setError(apiErrorText(res.error, 'profile.err.request')); return; }
    setNotice(t('profile.notice.requestSent', { name }));
    setResults(null); setQuery('');
    load();
  };

  const stat = (label: string, value: React.ReactNode) => (
    <div className="pp-stat" key={label}>
      <div className="pp-stat__v">{value}</div>
      <div className="pp-stat__k">{label}</div>
    </div>
  );

  const p = profile ?? {};
  const winRate = (p.games_played ?? 0) > 0
    ? Math.round((100 * (p.wins ?? 0)) / (p.games_played ?? 1))
    : 0;

  return (
    <div className="pp">
      {/* Over everything, on the return trip from Stripe. `unlocked`
          tracks the auth user so the goods light up the moment the
          webhook's grant lands, which may be after this renders. */}
      {thanks && (
        <CommissionThanks
          unlocked={!!user?.is_premium}
          onClose={() => setThanks(false)}
        />
      )}
      {notice && <div className="pp-notice">{notice}</div>}
      {error && <div className="pp-error">{error}</div>}

      {/* ---- the Commission, gifts ---- first, where it can be found */}
      <Hangar onRedeemed={() => setThanks(true)} giftJustBought={giftBought} />

      {/* ---- identity ---- */}
      <section className="pp-section">
        <div className="pp-h">{t('profile.h.account')}</div>
        <div className="pp-name-row">
          {editing ? (
            <>
              <input
                className="pp-input"
                value={draft}
                maxLength={24}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditing(false); }}
              />
              <button className="pp-btn pp-btn--primary" disabled={saving} onClick={saveName}>
                {saving ? t('profile.saving') : t('profile.save')}
              </button>
              <button className="pp-btn" disabled={saving} onClick={() => setEditing(false)}>{t('common.cancel')}</button>
            </>
          ) : (
            <>
              <span className="pp-name">{p.display_name ?? user?.display_name ?? '—'}</span>
              <button className="pp-btn" onClick={beginEdit}>{t('profile.changeName')}</button>
            </>
          )}
        </div>
        <div className="pp-sub">
          {user?.email}
          {/* The cooldown is enforced server-side; saying so up front is
              kinder than a 429 after the player has typed a new name. */}
          {' · '}{t('profile.nameCooldown')}
        </div>
      </section>

      {/* ---- email ---- */}
      <section className="pp-section" id="email-settings">
        <div className="pp-h">{t('profile.h.email')}</div>
        <EmailSettings />
      </section>

      {/* ---- career ---- */}
      <section className="pp-section">
        <div className="pp-h">{t('profile.h.career')}</div>
        <div className="pp-stats">
          {stat(t('profile.stat.games'), p.games_played ?? 0)}
          {stat(t('profile.stat.active'), p.games_active ?? 0)}
          {stat(t('profile.stat.wins'), p.wins ?? 0)}
          {stat(t('profile.stat.winRate'), `${winRate}%`)}
          {stat(t('profile.stat.kills'), p.kills ?? 0)}
          {stat(t('profile.stat.damage'), Math.round(p.damage_dealt ?? 0).toLocaleString())}
          {stat(t('profile.stat.built'), p.ships_built ?? 0)}
          {stat(t('profile.stat.lost'), p.ships_lost ?? 0)}
          {stat(t('profile.stat.settlements'), p.settlements_founded ?? 0)}
          {stat(t('profile.stat.bestCaptain'), t('profile.rank', { n: p.best_captain_rank ?? 0 }))}
        </div>
      </section>

      {/* ---- history ---- */}
      <section className="pp-section">
        <div className="pp-h">{t('profile.h.history')}</div>
        {history.length === 0 ? (
          <div className="pp-empty">{t('profile.noGames')}</div>
        ) : (
          <div className="pp-hist">
            {history.map(h => (
              <button
                key={h.game_id}
                className="pp-hist__row"
                onClick={() => onEnterRoom?.(h.game_id)}
                title={onEnterRoom ? t('profile.openGame') : undefined}
              >
                <span className="pp-hist__name">{h.room_name ?? h.game_id}</span>
                <span className="pp-hist__faction">{h.faction_name}</span>
                <span className={`pp-hist__status${h.won ? ' is-win' : ''}`}>
                  {h.won ? t('profile.won') : h.status === 'active' ? t('profile.inProgress') : tk(`profile.status.${h.status}`, h.status)}
                </span>
                <span className="pp-hist__tick">T+{h.current_tick}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ---- friends ---- */}
      <section className="pp-section">
        <div className="pp-h">{t('profile.h.friends')}{friends.length > 0 ? ` · ${friends.length}` : ''}</div>

        {incoming.length > 0 && (
          <>
            <div className="pp-sub">{t('profile.wantsFriends')}</div>
            {incoming.map(f => (
              <div className="pp-friend" key={f.user_id}>
                <span className="pp-friend__name">{f.display_name}</span>
                <span className="pp-friend__meta">{tn('profile.games', f.games_played)}</span>
                <button className="pp-btn pp-btn--primary"
                  onClick={() => act(`/api/users/me/friends/${f.user_id}/accept`, 'POST', t('profile.notice.nowFriends', { name: f.display_name }))}>
                  {t('profile.accept')}
                </button>
                <button className="pp-btn"
                  onClick={() => act(`/api/users/me/friends/${f.user_id}`, 'DELETE', t('profile.notice.declined'))}>
                  {t('profile.decline')}
                </button>
              </div>
            ))}
          </>
        )}

        {friends.length === 0 && incoming.length === 0 && outgoing.length === 0 && (
          <div className="pp-empty">{t('profile.noFriends')}</div>
        )}

        {friends.map(f => (
          <div className="pp-friend" key={f.user_id}>
            <span className="pp-friend__name">{f.display_name}</span>
            <span className="pp-friend__meta">{tn('profile.games', f.games_played)}</span>
            <button className="pp-btn"
              onClick={() => act(`/api/users/me/friends/${f.user_id}`, 'DELETE', t('profile.notice.removed', { name: f.display_name }))}>
              {t('profile.remove')}
            </button>
          </div>
        ))}

        {outgoing.map(f => (
          <div className="pp-friend pp-friend--pending" key={f.user_id}>
            <span className="pp-friend__name">{f.display_name}</span>
            <span className="pp-friend__meta">{t('profile.requestSent')}</span>
            <button className="pp-btn"
              onClick={() => act(`/api/users/me/friends/${f.user_id}`, 'DELETE', t('profile.notice.reqCancelled'))}>
              {t('common.cancel')}
            </button>
          </div>
        ))}

        <div className="pp-sub" style={{ marginTop: 12 }}>{t('profile.findPlayers')}</div>
        <div className="pp-name-row">
          <input
            className="pp-input"
            placeholder={t('profile.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          />
          <button className="pp-btn" disabled={searching} onClick={search}>
            {searching ? t('profile.searching') : t('profile.search')}
          </button>
        </div>
        {results && results.length === 0 && <div className="pp-empty">{t('profile.noMatch')}</div>}
        {results?.map(r => {
          const known = friends.some(f => f.user_id === r.user_id)
            || outgoing.some(f => f.user_id === r.user_id)
            || incoming.some(f => f.user_id === r.user_id);
          return (
            <div className="pp-friend" key={r.user_id}>
              <span className="pp-friend__name">{r.display_name}</span>
              <span className="pp-friend__meta">{tn('profile.games', r.games_played)}</span>
              <button className="pp-btn pp-btn--primary" disabled={known}
                onClick={() => addFriend(r.user_id, r.display_name)}>
                {known ? t('profile.alreadyAdded') : t('profile.addFriend')}
              </button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
