// ============================================================
// NotificationSettings — a player's own alert permissions.
//
// The admin panel can change anyone's settings for support ("stop DMing
// me"), and /notify works from Discord. This is the third surface and
// the one that matters most: it's in the game, where a player already
// is when a notification annoys them.
//
// Self-scoped by construction — the endpoint takes no user id, so this
// component cannot read or write anybody else's preferences.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';

type Prefs = Record<string, boolean>;
type Payload = {
  linked: boolean;
  discord_username: string | null;
  categories: Record<string, string>;
  prefs: Prefs;
};

/** Which categories are worth a warning when switched off. Losing a
 *  city because you muted the one alert that would have warned you is a
 *  bad experience we can cheaply prevent.
 *
 *  This used to point at 'urgent'. That category was removed for
 *  over-firing, and the facts it carried — settlements under fire,
 *  inbound hostile fleets — moved into the daily report. So the warning
 *  moved with them: the digest is now the only thing that tells you a
 *  city is burning. */
const HIGH_STAKES = new Set(['digest']);

export function NotificationSettings() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<Payload>('/api/me/notifications');
    if (res.ok) { setData(res.data); setErr(null); }
    else setErr('Could not load your notification settings.');
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (category: string, enabled: boolean) => {
    setBusy(category);
    const res = await apiFetch<{ prefs: Prefs }>('/api/me/notifications', {
      method: 'PATCH', body: JSON.stringify({ category, enabled }),
    });
    setBusy(null);
    if (res.ok) setData(d => (d ? { ...d, prefs: res.data.prefs } : d));
    else setErr('That change did not save. Try again.');
  };

  if (err) return <div style={sub}>{err}</div>;
  if (!data) return <div style={sub}>Loading…</div>;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={head}>Discord alerts</div>

      {!data.linked ? (
        <div style={sub}>
          Link your Discord account above to receive alerts. Once linked, you
          choose what reaches you here.
        </div>
      ) : (
        <>
          <div style={{ ...sub, marginBottom: 10 }}>
            Sent to <b style={{ color: '#cdd9e4' }}>{data.discord_username ?? 'your Discord'}</b>.
            You can also change these with <code style={code}>/notify</code> in Discord.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {Object.entries(data.categories).map(([key, label]) => {
              const on = data.prefs[key] !== false;
              const warn = HIGH_STAKES.has(key) && !on;
              return (
                <div key={key} style={row}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: '#cdd9e4' }}>{label}</div>
                    {warn && (
                      <div style={{ fontSize: 11, color: '#ffca28', marginTop: 2 }}>
                        Nothing will warn you about cities under fire or fleets inbound —
                        the daily report is the only alert that carries them.
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(key, !on)}
                    disabled={busy === key}
                    aria-pressed={on}
                    style={{
                      ...pill,
                      borderColor: on ? '#4ecdc4' : 'rgba(120,140,160,.35)',
                      color: on ? '#4ecdc4' : '#7d8fa3',
                      opacity: busy === key ? 0.5 : 1,
                    }}
                  >{on ? 'ON' : 'OFF'}</button>
                </div>
              );
            })}
          </div>

          <div style={{ ...sub, marginTop: 12 }}>
            Only deadlines interrupt you — a vote about to close, unpaid upkeep.
            Everything else, fighting and inbound fleets included, is gathered
            into your daily situation report.
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
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: '7px 10px',
  background: 'rgba(20,32,46,.5)', border: '1px solid rgba(96,130,160,.22)',
  borderRadius: 6,
};
const pill: React.CSSProperties = {
  background: 'transparent', border: '1px solid', borderRadius: 999,
  fontSize: 10.5, letterSpacing: '.08em', padding: '3px 11px',
  cursor: 'pointer', flexShrink: 0, minWidth: 52,
};
const code: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace', color: '#4ecdc4', fontSize: 11.5,
};


/**
 * The same panel as a centred dialog, opened from the ACCOUNT section of
 * the side menu. It lives there rather than inside the Senate because
 * these are account preferences, not a senate feature — a player looking
 * to stop a notification will reach for the menu, not for a government
 * screen they may never open.
 */
export function NotificationSettingsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 8000,
        background: 'rgba(4,8,14,.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18,
      }}
    >
      <div
        role="dialog"
        aria-label="Discord alert settings"
        onClick={e => e.stopPropagation()}
        style={{
          background: '#0b111a', border: '1px solid rgba(96,130,160,.35)',
          borderRadius: 10, padding: '18px 20px 20px',
          width: 'min(520px, 100%)', maxHeight: '86vh', overflowY: 'auto',
          boxShadow: '0 18px 60px rgba(0,0,0,.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e7eef6' }}>Notifications</div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              background: 'transparent', border: '1px solid rgba(96,130,160,.4)',
              color: '#8a9fb3', borderRadius: 6, cursor: 'pointer',
              width: 30, height: 30, fontSize: 15, lineHeight: 1,
            }}
          >×</button>
        </div>
        <NotificationSettings />
      </div>
    </div>
  );
}
