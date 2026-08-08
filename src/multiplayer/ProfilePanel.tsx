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
import { useAuth } from './AuthContext';

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
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState<CareerProfile | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [incoming, setIncoming] = useState<FriendRow[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!res.ok) { setError(res.error?.message ?? 'Could not change name'); return; }
    setEditing(false);
    setNotice('Name updated');
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
    if (query.trim().length < 2) { setError('Type at least 2 characters'); return; }
    setSearching(true); setError(null);
    const res = await apiFetch<{ players: Array<{ id: string; display_name: string; games_played: number }> }>(
      `/api/users/search?q=${encodeURIComponent(query.trim())}`,
    );
    setSearching(false);
    if (!res.ok) { setError(res.error?.message ?? 'Search failed'); return; }
    setResults(res.data.players.map(p => ({
      user_id: p.id, display_name: p.display_name, games_played: p.games_played, since: 0,
    })));
  };
  const act = async (path: string, method: string, msg: string) => {
    setError(null);
    const res = await apiFetch(path, { method });
    if (!res.ok) { setError(res.error?.message ?? 'Failed'); return; }
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
    if (!res.ok) { setError(res.error?.message ?? 'Could not send request'); return; }
    setNotice(`Request sent to ${name}`);
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
      {notice && <div className="pp-notice">{notice}</div>}
      {error && <div className="pp-error">{error}</div>}

      {/* ---- identity ---- */}
      <section className="pp-section">
        <div className="pp-h">ACCOUNT</div>
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
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="pp-btn" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="pp-name">{p.display_name ?? user?.display_name ?? '—'}</span>
              <button className="pp-btn" onClick={beginEdit}>Change name</button>
            </>
          )}
        </div>
        <div className="pp-sub">
          {user?.email}
          {/* The cooldown is enforced server-side; saying so up front is
              kinder than a 429 after the player has typed a new name. */}
          {' · '}names can be changed once a day
        </div>
      </section>

      {/* ---- career ---- */}
      <section className="pp-section">
        <div className="pp-h">CAREER</div>
        <div className="pp-stats">
          {stat('GAMES', p.games_played ?? 0)}
          {stat('ACTIVE', p.games_active ?? 0)}
          {stat('WINS', p.wins ?? 0)}
          {stat('WIN RATE', `${winRate}%`)}
          {stat('KILLS', p.kills ?? 0)}
          {stat('DAMAGE', Math.round(p.damage_dealt ?? 0).toLocaleString())}
          {stat('SHIPS BUILT', p.ships_built ?? 0)}
          {stat('SHIPS LOST', p.ships_lost ?? 0)}
          {stat('SETTLEMENTS', p.settlements_founded ?? 0)}
          {stat('BEST CAPTAIN', `rank ${p.best_captain_rank ?? 0}`)}
        </div>
      </section>

      {/* ---- history ---- */}
      <section className="pp-section">
        <div className="pp-h">HISTORY</div>
        {history.length === 0 ? (
          <div className="pp-empty">No games yet.</div>
        ) : (
          <div className="pp-hist">
            {history.map(h => (
              <button
                key={h.game_id}
                className="pp-hist__row"
                onClick={() => onEnterRoom?.(h.game_id)}
                title={onEnterRoom ? 'Open this game' : undefined}
              >
                <span className="pp-hist__name">{h.room_name ?? h.game_id}</span>
                <span className="pp-hist__faction">{h.faction_name}</span>
                <span className={`pp-hist__status${h.won ? ' is-win' : ''}`}>
                  {h.won ? '★ WON' : h.status === 'active' ? 'in progress' : h.status}
                </span>
                <span className="pp-hist__tick">T+{h.current_tick}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ---- friends ---- */}
      <section className="pp-section">
        <div className="pp-h">FRIENDS{friends.length > 0 ? ` · ${friends.length}` : ''}</div>

        {incoming.length > 0 && (
          <>
            <div className="pp-sub">Wants to be friends</div>
            {incoming.map(f => (
              <div className="pp-friend" key={f.user_id}>
                <span className="pp-friend__name">{f.display_name}</span>
                <span className="pp-friend__meta">{f.games_played} games</span>
                <button className="pp-btn pp-btn--primary"
                  onClick={() => act(`/api/users/me/friends/${f.user_id}/accept`, 'POST', `You and ${f.display_name} are now friends`)}>
                  Accept
                </button>
                <button className="pp-btn"
                  onClick={() => act(`/api/users/me/friends/${f.user_id}`, 'DELETE', 'Request declined')}>
                  Decline
                </button>
              </div>
            ))}
          </>
        )}

        {friends.length === 0 && incoming.length === 0 && outgoing.length === 0 && (
          <div className="pp-empty">No friends yet — search for a player below.</div>
        )}

        {friends.map(f => (
          <div className="pp-friend" key={f.user_id}>
            <span className="pp-friend__name">{f.display_name}</span>
            <span className="pp-friend__meta">{f.games_played} games</span>
            <button className="pp-btn"
              onClick={() => act(`/api/users/me/friends/${f.user_id}`, 'DELETE', `Removed ${f.display_name}`)}>
              Remove
            </button>
          </div>
        ))}

        {outgoing.map(f => (
          <div className="pp-friend pp-friend--pending" key={f.user_id}>
            <span className="pp-friend__name">{f.display_name}</span>
            <span className="pp-friend__meta">request sent</span>
            <button className="pp-btn"
              onClick={() => act(`/api/users/me/friends/${f.user_id}`, 'DELETE', 'Request cancelled')}>
              Cancel
            </button>
          </div>
        ))}

        <div className="pp-sub" style={{ marginTop: 12 }}>Find players</div>
        <div className="pp-name-row">
          <input
            className="pp-input"
            placeholder="Search by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          />
          <button className="pp-btn" disabled={searching} onClick={search}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {results && results.length === 0 && <div className="pp-empty">No players matched.</div>}
        {results?.map(r => {
          const known = friends.some(f => f.user_id === r.user_id)
            || outgoing.some(f => f.user_id === r.user_id)
            || incoming.some(f => f.user_id === r.user_id);
          return (
            <div className="pp-friend" key={r.user_id}>
              <span className="pp-friend__name">{r.display_name}</span>
              <span className="pp-friend__meta">{r.games_played} games</span>
              <button className="pp-btn pp-btn--primary" disabled={known}
                onClick={() => addFriend(r.user_id, r.display_name)}>
                {known ? 'Already added' : 'Add friend'}
              </button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
