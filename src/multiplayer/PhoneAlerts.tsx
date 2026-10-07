// ============================================================
// PhoneAlerts — notifications on this device.
//
// Sits above the Discord section in NotificationSettings because it is
// the one that needs no account linking and reaches the most people: a
// tick is an hour, players check in from a phone for half an hour at a
// time, and until now the only way the game could reach someone who was
// away was a Discord DM they had to have set up.
//
// PER DEVICE, deliberately said out loud. A subscription belongs to one
// browser on one machine; turning it on at a desk does nothing for the
// phone. People assume it is an account setting and then think it is
// broken, so the copy says which it is.
//
// WHAT reaches this device is chosen in the matrix below, which has its
// own Phone column. So this component offers exactly two things: the
// device-level on switch, and a way to prove a notification actually
// arrives. It is not a second copy of the category list.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import {
  pushState, enablePush, disablePush, sendTestPush, type PushState,
} from '../platform/push';
import { t } from '../i18n/core';
import { tRich } from '../i18n/rich';
import { useI18n } from '../i18n/react';

const head: React.CSSProperties = {
  fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase',
  color: '#8aa0b4', marginBottom: 8,
};
const sub: React.CSSProperties = { fontSize: 11.5, color: '#8aa0b4', lineHeight: 1.55 };
const pill: React.CSSProperties = {
  background: 'transparent', border: '1px solid rgba(96,130,160,.45)',
  borderRadius: 999, color: '#cdd9e4', cursor: 'pointer',
  fontSize: 11.5, padding: '6px 12px',
};

export function PhoneAlerts() {
  useI18n();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => { setState(await pushState()); }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (state === null) return null;

  const turnOn = async () => {
    setBusy(true); setErr(null); setNote(null);
    const res = await enablePush();
    setBusy(false);
    setState(res.state);
    if (res.error) setErr(res.error);
    else setNote(t('mp.alerts.noteOn'));
  };

  const turnOff = async () => {
    setBusy(true); setErr(null); setNote(null);
    await disablePush();
    setBusy(false);
    await refresh();
    setNote(t('mp.alerts.noteOff'));
  };

  const test = async () => {
    setBusy(true); setErr(null); setNote(null);
    const problem = await sendTestPush();
    setBusy(false);
    if (problem) setErr(problem);
    else setNote(t('mp.alerts.noteSent'));
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={head}>{t('mp.alerts.head')}</div>

      {state === 'unsupported' ? (
        <div style={sub}>
          {t('mp.alerts.unsupported')}
        </div>
      ) : state === 'denied' ? (
        <div style={sub}>
          {t('mp.alerts.denied')}
        </div>
      ) : state === 'subscribed' ? (
        <>
          <div style={{ ...sub, marginBottom: 10 }}>
            {t('mp.alerts.on')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={pill} disabled={busy} onClick={() => void test()}>
              {t('mp.alerts.test')}
            </button>
            <button type="button" style={pill} disabled={busy} onClick={() => void turnOff()}>
              {t('mp.alerts.off')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ ...sub, marginBottom: 10 }}>
            {tRich('mp.alerts.ask', { device: <b style={{ color: '#cdd9e4' }}>{t('mp.alerts.thisDevice')}</b> })}
          </div>
          <button
            type="button"
            style={{ ...pill, borderColor: '#4ecdc4', color: '#4ecdc4' }}
            disabled={busy}
            onClick={() => void turnOn()}
          >
            {busy ? t('mp.alerts.asking') : t('mp.alerts.turnOn')}
          </button>
        </>
      )}

      {note && <div style={{ ...sub, color: '#6ee7b7', marginTop: 8 }}>{note}</div>}
      {err && <div style={{ ...sub, color: '#ffca28', marginTop: 8 }}>{err}</div>}
    </div>
  );
}
