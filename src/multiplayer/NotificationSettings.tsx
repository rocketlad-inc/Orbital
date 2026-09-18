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
import { PhoneAlerts } from './PhoneAlerts';
import { WidgetLink } from './WidgetLink';

type Prefs = Record<string, boolean>;
type Payload = {
  linked: boolean;
  discord_username: string | null;
  categories: Record<string, string>;
  /** Discord answers. Keeps its old name because the endpoint has always
   *  returned it under that key and the admin panel still reads it. */
  prefs: Prefs;
  /** Phone answers. Identical until the player touches a phone switch,
   *  at which point that category's two transports go their own way. */
  push_prefs: Prefs;
  /** Devices registered for push on this ACCOUNT, not this browser. */
  push_devices: number;
  /** null = linked but never answered the DM question. */
  dm_consent: boolean | null;
};

type Transport = 'push' | 'discord';

/** The three that carry "a city of yours is burning". The warning fires
 *  only when ALL of them are off on BOTH transports, because any one of
 *  them still reaching you means you are not blind — and a warning that
 *  cries wolf on a reasonable choice is one people learn to ignore. */
const BLIND_SPOT = ['digest', 'combat', 'inbound'];

export function NotificationSettings() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dmBlocked, setDmBlocked] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch<Payload>('/api/me/notifications');
    if (res.ok) { setData(res.data); setErr(null); }
    else setErr('Could not load your notification settings.');
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (category: string, enabled: boolean, transport: Transport) => {
    // Keyed by transport as well as category: the two switches on a row
    // are separate requests, and a shared busy key would grey out both.
    setBusy(`${transport}:${category}`);
    const res = await apiFetch<{ prefs: Prefs; push_prefs: Prefs }>('/api/me/notifications', {
      method: 'PATCH', body: JSON.stringify({ category, enabled, transport }),
    });
    setBusy(null);
    // Both halves are taken from the response rather than patched
    // locally: writing a phone preference can create the row the Discord
    // column renders from, so guessing here would drift from the server.
    if (res.ok) {
      setData(d => (d ? { ...d, prefs: res.data.prefs, push_prefs: res.data.push_prefs } : d));
    } else setErr('That change did not save. Try again.');
  };

  // Answering the master question. On "yes" the server sends a welcome DM
  // and tells us whether it landed — Discord blocks server-member DMs by
  // default for many accounts, and if we didn't surface that the player
  // would sit opted-in and silent, concluding the bot is broken.
  const answerConsent = async (consent: boolean) => {
    setBusy('consent');
    const res = await apiFetch<{ dm_consent: boolean; dm_ok: boolean | null }>(
      '/api/me/dm-consent', { method: 'POST', body: JSON.stringify({ consent }) },
    );
    setBusy(null);
    if (!res.ok) { setErr('That change did not save. Try again.'); return; }
    setDmBlocked(consent && res.data.dm_ok === false);
    setData(d => (d ? { ...d, dm_consent: res.data.dm_consent } : d));
  };

  if (err) return <div style={sub}>{err}</div>;
  if (!data) return <div style={sub}>Loading…</div>;

  const discordLive = data.linked && data.dm_consent === true;
  // Evaluated once for the whole list rather than per row: the question
  // is about the SET of alerts that can warn you, not about any one of
  // them, so the notice belongs under the group and not beside a switch.
  const blind = BLIND_SPOT.every(
    k => data.prefs[k] === false && data.push_prefs[k] === false,
  );

  return (
    <div style={{ marginTop: 14 }}>
      {/* FIRST, because it needs no account linking and reaches the most
          people. */}
      <PhoneAlerts />

      {/* ONE LIST OF ALERTS, TWO COLUMNS OF WHERE THEY GO.
          This used to live inside the Discord branch, which meant a
          player who had never linked Discord could turn push on and then
          had no way whatsoever to choose what it sent them — the whole
          list was hidden behind an account they did not have. The
          question "what do you want to hear about" is not a Discord
          question, so it is asked first and on its own. */}
      <div style={{ ...head, marginTop: 18 }}>What reaches you</div>

      <div style={{ ...colHead }}>
        <span style={{ flex: 1 }} />
        <span style={colLabel}>Phone</span>
        <span style={colLabel}>Discord</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {Object.entries(data.categories).map(([key, label]) => {
          const onPush = data.push_prefs[key] !== false;
          const onDm = data.prefs[key] !== false;
          return (
            <div key={key} style={row}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, color: '#cdd9e4' }}>{label}</div>
              </div>
              <Toggle
                on={onPush}
                busy={busy === `push:${key}`}
                label={`${label} on your phone`}
                onClick={() => toggle(key, !onPush, 'push')}
              />
              <Toggle
                on={onDm}
                busy={busy === `discord:${key}`}
                disabled={!discordLive}
                label={`${label} in Discord`}
                onClick={() => toggle(key, !onDm, 'discord')}
              />
            </div>
          );
        })}
      </div>

      {blind && (
        <div style={{
          fontSize: 11.5, color: '#ffca28', marginTop: 9, lineHeight: 1.5,
          border: '1px solid rgba(255,202,40,.3)', borderRadius: 6, padding: '8px 10px',
        }}>
          Nothing will warn you that a city is under fire or that a fleet is on its
          way. Fighting, inbound and the daily report are all off — leave any one of
          them on and you will still hear about it.
        </div>
      )}

      {data.push_devices === 0 && (
        <div style={{ ...sub, marginTop: 8 }}>
          No device is set up for phone alerts yet — turn them on above, on the
          device you want them to reach.
        </div>
      )}
      {!discordLive && (
        <div style={{ ...sub, marginTop: 8 }}>
          The Discord column needs a linked account with direct messages on.
        </div>
      )}

      {/* The other thing your phone does with Orbital. It sits here
          rather than in a panel of its own because this modal is already
          the "how the game reaches you" surface, and a player hunting
          for phone settings opens exactly one thing. */}
      <WidgetLink />

      <div style={{ ...head, marginTop: 18 }}>Discord account</div>

      {!data.linked ? (
        <div style={sub}>
          Link your Discord account above to receive alerts. Once linked, you
          choose what reaches you here.
        </div>
      ) : data.dm_consent == null ? (
        // Linked but never asked. Pose the question rather than assuming
        // either answer — linking is permission to vote from Discord, not
        // permission to message someone.
        <div style={{
          border: '1px solid rgba(96,130,160,.3)', borderRadius: 8, padding: '12px 14px',
        }}>
          <div style={{ fontSize: 12.5, color: '#cdd9e4', marginBottom: 8 }}>
            Do you want Orbital to send you direct messages?
          </div>
          <div style={{ ...sub, marginBottom: 10 }}>
            Senate cards, the Orbital Herald and slash commands reach you in the server
            either way. This is only about your inbox.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button" onClick={() => answerConsent(true)} disabled={busy === 'consent'}
              style={{ ...pill, borderColor: '#4ecdc4', color: '#4ecdc4', padding: '6px 12px' }}
            >📬 Yes, DM me</button>
            <button
              type="button" onClick={() => answerConsent(false)} disabled={busy === 'consent'}
              style={{ ...pill, padding: '6px 12px' }}
            >🔕 Server only</button>
          </div>
        </div>
      ) : data.dm_consent === false ? (
        <div>
          <div style={{ fontSize: 12.5, color: '#cdd9e4' }}>🔕 Server only</div>
          <div style={{ ...sub, marginTop: 4, marginBottom: 10 }}>
            Nothing reaches your inbox. Senate cards, the Herald and every slash command
            still work in the server.
          </div>
          <button
            type="button" onClick={() => answerConsent(true)} disabled={busy === 'consent'}
            style={{ ...pill, borderColor: '#4ecdc4', color: '#4ecdc4', padding: '6px 12px' }}
          >Turn direct messages on</button>
        </div>
      ) : (
        <>
          <div style={{ ...sub, marginBottom: 10 }}>
            Sent to <b style={{ color: '#cdd9e4' }}>{data.discord_username ?? 'your Discord'}</b>.
            You can also change these with <code style={code}>/notify</code> in Discord.
          </div>

          {dmBlocked && (
            <div style={{
              fontSize: 11.5, color: '#ffca28', marginBottom: 10, lineHeight: 1.5,
              border: '1px solid rgba(255,202,40,.3)', borderRadius: 6, padding: '8px 10px',
            }}>
              Discord blocked our test message. Right-click the server icon →
              <b> Privacy Settings</b> → enable <b>Direct Messages</b>, or none of this
              will reach you.
            </div>
          )}

          <button
            type="button" onClick={() => answerConsent(false)} disabled={busy === 'consent'}
            style={{ ...pill, marginTop: 10, padding: '6px 12px' }}
          >🔕 Stop all direct messages</button>

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

/**
 * One switch in the matrix.
 *
 * A disabled column still renders its state rather than vanishing: a
 * player whose Discord is unlinked should be able to SEE that senate
 * alerts would go there, otherwise the row silently changes width
 * depending on account setup and the two columns stop lining up.
 */
function Toggle(
  { on, busy, disabled, label, onClick }:
  { on: boolean; busy: boolean; disabled?: boolean; label: string; onClick: () => void },
) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      aria-pressed={on}
      aria-label={label}
      title={disabled ? 'Needs a linked Discord account' : label}
      style={{
        ...pill,
        cursor: disabled ? 'default' : 'pointer',
        borderColor: disabled ? 'rgba(96,130,160,.18)' : on ? '#4ecdc4' : 'rgba(120,140,160,.35)',
        color: disabled ? '#4c5c6e' : on ? '#4ecdc4' : '#7d8fa3',
        opacity: busy ? 0.5 : 1,
      }}
    >{disabled ? '—' : on ? 'ON' : 'OFF'}</button>
  );
}

const head: React.CSSProperties = {
  fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase',
  color: '#7fd8cf', marginBottom: 8, fontWeight: 700,
};
/** Column headings, aligned to the two pills by matching their width. */
const colHead: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '0 10px 6px', marginTop: -2,
};
const colLabel: React.CSSProperties = {
  width: 52, flexShrink: 0, textAlign: 'center',
  fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: '#6d8296',
};
const sub: React.CSSProperties = { fontSize: 12, color: '#8a9fb3', lineHeight: 1.5 };
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  gap: 8, padding: '7px 10px',
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
