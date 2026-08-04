// ============================================================
// BotControl — the Discord bot's control room.
//
// Admin-only (server re-checks every request; this renders nothing
// useful for anyone else). Four jobs, in the order you'd actually use
// them:
//   1. Is it wired?   — secrets present, at a glance
//   2. Schedule       — when things fire, and master switches
//   3. Who gets what  — per-player categories, mutable here
//   4. Did it work?   — recent deliveries and 7-day counts
//
// Everything writes through to the same settings the cron reads, so a
// change here takes effect on the next minute without a deploy.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';
import './AdminAnalytics.css';

type Prefs = Record<string, boolean>;
type Player = { id: string; display_name: string; discord_username: string | null; prefs: Prefs };
type Delivery = { category: string; ok: number; created_ms: number; game_id: string | null; display_name: string | null };
type Count = { category: string; n: number; delivered: number };
type GameRow = { id: string; name: string; current_tick: number };

type Guild = { id: string; name: string };

type BotData = {
  settings: Record<string, number | boolean>;
  guilds: Guild[];
  defaults: Record<string, number | boolean>;
  categories: Record<string, string>;
  wired: Record<string, boolean>;
  players: Player[];
  recent: Delivery[];
  counts: Count[];
  games: GameRow[];
};

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return { value: h, label: `${hh}${ampm} ET` };
});

function ago(now: number, ms: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function BotControl() {
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<BotData>('/api/admin/bot');
    if (res.ok) { setData(res.data); setError(null); }
    else setError('Bot control is unavailable for this account.');
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2600); };

  const writeSetting = async (key: string, value: number | boolean) => {
    setBusy(key);
    const res = await apiFetch<{ settings: BotData['settings'] }>('/api/admin/bot', {
      method: 'PATCH', body: JSON.stringify({ key, value }),
    });
    setBusy(null);
    if (res.ok) { setData(d => (d ? { ...d, settings: res.data.settings } : d)); flash('Saved'); }
    else flash('Could not save that setting');
  };

  const writePref = async (userId: string, category: string, enabled: boolean) => {
    setBusy(`${userId}:${category}`);
    const res = await apiFetch<{ prefs: Prefs }>('/api/admin/bot/prefs', {
      method: 'PATCH', body: JSON.stringify({ user_id: userId, category, enabled }),
    });
    setBusy(null);
    if (res.ok) {
      setData(d => d && ({
        ...d,
        players: d.players.map(p => (p.id === userId ? { ...p, prefs: res.data.prefs } : p)),
      }));
    } else flash('Could not change that');
  };

  const fire = async (path: string, label: string) => {
    setBusy(label);
    const res = await apiFetch<unknown>(path, { method: 'POST' });
    setBusy(null);
    flash(res.ok ? `${label} sent` : `${label} failed`);
    load();
  };

  if (error) return <div className="aa-empty">{error}</div>;
  if (!data) return <div className="aa-empty">Loading bot control…</div>;

  const now = Date.now();
  const s = data.settings;

  return (
    <div className="aa-root">
      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(20,32,46,.97)', border: '1px solid #4ecdc4', color: '#4ecdc4',
          borderRadius: 8, padding: '9px 16px', fontSize: 13, zIndex: 9999,
        }}>{toast}</div>
      )}

      {/* ---- wiring ---- */}
      <section>
        <div className="aa-section-title">CONNECTION</div>
        <div className="aa-cards">
          {Object.entries(data.wired).map(([k, ok]) => (
            <div key={k} className="aa-card" style={{ cursor: 'default' }}>
              <div className="aa-card__name">
                <span className="aa-hdot" style={{ background: ok ? '#4ecdc4' : '#ff6b6b' }} />
                {k.replace(/_/g, ' ')}
              </div>
              <div className="aa-card__row aa-card__row--dim">
                {ok ? 'configured' : 'not set'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- schedule + switches ---- */}
      <section>
        <div className="aa-section-title">SCHEDULE &amp; SWITCHES</div>
        <div className="aa-scroll-x">
          <table className="aa-table">
            <tbody>
              <tr>
                <td style={{ width: 260 }}>Situation reports (DM)</td>
                <td>
                  <select
                    value={Number(s.sitrep_hour_eastern)}
                    disabled={busy === 'sitrep_hour_eastern'}
                    onChange={e => writeSetting('sitrep_hour_eastern', Number(e.target.value))}
                    style={selStyle}
                  >
                    {HOUR_LABELS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                  </select>
                </td>
                <td><Toggle on={!!s.sitrep_enabled} busy={busy === 'sitrep_enabled'}
                  onChange={v => writeSetting('sitrep_enabled', v)} /></td>
              </tr>
              <tr>
                <td>Send when nothing needs them</td>
                <td style={{ color: '#8a9fb3', fontSize: 12 }}>
                  Off means a report only arrives when something wants you.
                </td>
                <td><Toggle on={!!s.sitrep_send_when_quiet} busy={busy === 'sitrep_send_when_quiet'}
                  onChange={v => writeSetting('sitrep_send_when_quiet', v)} /></td>
              </tr>
              <tr>
                <td>The Orbital Herald (channel)</td>
                <td>
                  <select
                    value={Number(s.herald_hour_eastern)}
                    disabled={busy === 'herald_hour_eastern'}
                    onChange={e => writeSetting('herald_hour_eastern', Number(e.target.value))}
                    style={selStyle}
                  >
                    {HOUR_LABELS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                  </select>
                </td>
                <td><Toggle on={!!s.herald_enabled} busy={busy === 'herald_enabled'}
                  onChange={v => writeSetting('herald_enabled', v)} /></td>
              </tr>
              <tr>
                <td>Senate vote cards</td>
                <td style={{ color: '#8a9fb3', fontSize: 12 }}>Bill announcements + vote buttons</td>
                <td><Toggle on={!!s.senate_cards_enabled} busy={busy === 'senate_cards_enabled'}
                  onChange={v => writeSetting('senate_cards_enabled', v)} /></td>
              </tr>
              <tr>
                <td>Relay in-game messages to DMs</td>
                <td style={{ color: '#8a9fb3', fontSize: 12 }}>Sends the claimed sender, never the real one</td>
                <td><Toggle on={!!s.dm_relay_enabled} busy={busy === 'dm_relay_enabled'}
                  onChange={v => writeSetting('dm_relay_enabled', v)} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- manual triggers ---- */}
      <section>
        <div className="aa-section-title">SEND NOW</div>
        <div className="aa-metric-tabs">
          {data.games.map(g => (
            <button
              key={g.id}
              className="aa-chip"
              disabled={busy === `sitrep:${g.id}`}
              onClick={() => fire(`/api/admin/sitrep/${g.id}?force=1`, `sitrep:${g.id}`)}
            >
              Situation reports · {g.name}
            </button>
          ))}
          {(data.guilds ?? []).map(g => (
            <button
              key={g.id}
              className="aa-chip"
              disabled={busy === `register:${g.id}`}
              onClick={() => fire(`/api/admin/discord/register-commands?guild=${g.id}`, `register:${g.id}`)}
            >
              Re-register commands · {g.name}
            </button>
          ))}
        </div>
        <div className="aa-axis" style={{ fontSize: 11, paddingTop: 8 }}>
          Forced sends use a one-off dedupe key, so testing never consumes the day's real delivery.
        </div>
      </section>

      {/* ---- who gets what ---- */}
      <section>
        <div className="aa-section-title">LINKED PLAYERS · WHO GETS WHAT</div>
        {data.players.length === 0 ? (
          <div className="aa-empty">Nobody has linked Discord yet. They run <code>/link</code> with a code from the in-game Senate panel.</div>
        ) : (
          <div className="aa-scroll-x">
            <table className="aa-table">
              <thead>
                <tr>
                  <th>Player</th><th>Discord</th>
                  {Object.keys(data.categories).map(c => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.players.map(p => (
                  <tr key={p.id}>
                    <td>{p.display_name}</td>
                    <td style={{ color: '#8a9fb3' }}>{p.discord_username ?? '—'}</td>
                    {Object.keys(data.categories).map(c => (
                      <td key={c}>
                        <button
                          className="aa-chip"
                          title={data.categories[c]}
                          disabled={busy === `${p.id}:${c}`}
                          onClick={() => writePref(p.id, c, !p.prefs[c])}
                          style={{
                            borderColor: p.prefs[c] ? '#4ecdc4' : 'rgba(96,130,160,.35)',
                            color: p.prefs[c] ? '#4ecdc4' : '#5f7186',
                            padding: '2px 8px',
                          }}
                        >{p.prefs[c] ? 'on' : 'off'}</button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- delivery ---- */}
      <section>
        <div className="aa-section-title">DELIVERY · LAST 7 DAYS</div>
        {data.counts.length === 0 ? (
          <div className="aa-empty">Nothing sent yet.</div>
        ) : (
          <div className="aa-bars">
            {data.counts.map(c => (
              <div key={c.category} className="aa-bar-row">
                <span className="aa-bar-label">{c.category}</span>
                <span className="aa-bar-track">
                  <span className="aa-bar-fill" style={{ width: `${(c.delivered / Math.max(1, c.n)) * 100}%` }} />
                </span>
                <span className="aa-bar-num">
                  {c.delivered}/{c.n} <em>delivered</em>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="aa-section-title">RECENT SENDS</div>
        {data.recent.length === 0 ? <div className="aa-empty">No sends recorded.</div> : (
          <div className="aa-scroll-x">
            <table className="aa-table">
              <thead><tr><th>When</th><th>Player</th><th>Category</th><th>Result</th></tr></thead>
              <tbody>
                {data.recent.map((r, i) => (
                  <tr key={i}>
                    <td>{ago(now, r.created_ms)}</td>
                    <td>{r.display_name ?? '—'}</td>
                    <td>{r.category}</td>
                    <td style={{ color: r.ok ? '#4ecdc4' : '#ff6b6b' }}>{r.ok ? 'delivered' : 'failed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  background: 'rgba(20,32,46,.9)', color: '#cdd9e4',
  border: '1px solid rgba(96,130,160,.4)', borderRadius: 6, padding: '5px 9px', fontSize: 12.5,
};

function Toggle({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className="aa-chip"
      disabled={busy}
      onClick={() => onChange(!on)}
      style={{
        borderColor: on ? '#4ecdc4' : 'rgba(96,130,160,.35)',
        color: on ? '#4ecdc4' : '#5f7186',
        minWidth: 62,
      }}
    >{on ? 'ON' : 'OFF'}</button>
  );
}
