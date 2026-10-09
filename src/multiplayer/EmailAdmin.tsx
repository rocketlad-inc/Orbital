// ============================================================
// EmailAdmin — the win-back email: its switch, its words, its numbers.
//
// worker/emailAdmin.js serves everything here. Three choices:
//
//   OFF UNTIL YOU SAY. The email ships switched off. Turning it on asks
//   first and says how many people are waiting, because the first hour
//   after the switch mails real inboxes.
//
//   THE PREVIEW IS THE MAIL. It is rendered by the worker, through the
//   same function the hourly run sends with, around the lobby the next
//   run would actually name (or a sample when none is open). Edits show
//   up in it before they are saved, and "Send test to me" sends exactly
//   the draft on screen.
//
//   BLANK MEANS DEFAULT. Each field shows the catalog's words as its
//   placeholder; typing overrides them for that language only, and
//   clearing the box goes back. Card labels are not editable: they mirror
//   the game browser.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './AdminAnalytics.css';
import './EmailAdmin.css';
import { ago } from './adminFormat';

type Locale = 'en' | 'pt-BR';
type Mode = 'seat' | 'pool';
type Overrides = Partial<Record<Locale, Record<string, string>>> & { hero_src?: string };

interface Field { key: string; label: string; vars: string[]; defaults: Record<Locale, string> }
interface Counts { sent: number; failed: number; opened: number; clicked: number; joined: number; playing: number; unsubscribed: number }
interface Day { day: string; sent: number; opened: number; clicked: number }
interface Recent {
  name: string; email: string | null; mode: Mode; sent_ms: number; ok: boolean; error: string | null;
  opened_ms: number | null; open_count: number; clicked_ms: number | null; joined_ms: number | null;
  playing: boolean; unsubscribed: boolean;
  room_name?: string | null; signed_in?: boolean;
}
interface Payload {
  enabled: boolean;
  overrides: Overrides;
  updated_ms: number | null;
  updated_by: string | null;
  fields: Field[];
  locales: Locale[];
  max_chars: number;
  hero_default: string;
  email_configured: boolean;
  metrics: { totals: Counts; byMode: Record<Mode, Counts>; daily: Day[]; recent: Recent[] };
  queue: {
    waiting: number; enabled: boolean; next_run_ms: number | null; hourly_cap: number;
    next: {
      mode: 'seat' | 'pool' | 'hold';
      reason?: 'invited' | 'too_few' | 'nobody_waiting' | null;
      count: number;
      rooms: { name: string; n: number; max_players: number; count: number; pending?: number }[];
    };
  };
}

const LOCALE_LABEL: Record<Locale, string> = { en: 'English', 'pt-BR': 'Português' };
const MODE_LABEL: Record<Mode, string> = { seat: 'A game is filling up', pool: 'A new game is forming' };

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: data?.error?.message ?? `Request failed (${res.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, message: 'Network error.' };
  }
}

/** Overrides minus blanks, so "dirty" and "saved" compare honestly. */
function tidy(o: Overrides): Overrides {
  const out: Overrides = {};
  for (const L of ['en', 'pt-BR'] as Locale[]) {
    const src = o[L];
    if (!src) continue;
    const kept = Object.fromEntries(Object.entries(src).filter(([, v]) => v.trim() !== ''));
    if (Object.keys(kept).length) out[L] = kept;
  }
  if (o.hero_src?.trim()) out.hero_src = o.hero_src.trim();
  return out;
}

export const EmailAdmin: React.FC = () => {
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Overrides>({});
  const [locale, setLocale] = useState<Locale>('en');
  const [mode, setMode] = useState<Mode>('seat');
  const [preview, setPreview] = useState<{ html: string; subject: string; preheader: string; room_source: string | null } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const res = await call<Payload>('/api/admin/email/winback');
    if (!res.ok) { setError(res.message); return; }
    setData(res.data);
    setDraft(res.data.overrides ?? {});
    setNow(Date.now());
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(
    () => !!data && JSON.stringify(tidy(draft)) !== JSON.stringify(tidy(data.overrides ?? {})),
    [draft, data],
  );

  // Re-render the preview as the draft changes, a beat after typing stops.
  const seq = useRef(0);
  useEffect(() => {
    if (!data) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const res = await call<{ html: string; subject: string; preheader: string; room_source: string | null }>(
        '/api/admin/email/winback/preview',
        { method: 'POST', body: JSON.stringify({ locale, mode, overrides: tidy(draft) }) },
      );
      if (mine !== seq.current) return;
      if (res.ok) { setPreview(res.data); setPreviewError(null); } else setPreviewError(res.message);
    }, 350);
    return () => clearTimeout(timer);
  }, [data, draft, locale, mode]);

  const setField = (key: string, value: string) => {
    setDraft(d => ({ ...d, [locale]: { ...(d[locale] ?? {}), [key]: value } }));
    setNote(null);
  };
  const resetField = (key: string) => {
    setDraft(d => {
      const mine = { ...(d[locale] ?? {}) };
      delete mine[key];
      return { ...d, [locale]: mine };
    });
  };

  const save = async () => {
    setBusy('save'); setError(null); setNote(null);
    const res = await call<{ overrides: Overrides }>('/api/admin/email/winback', {
      method: 'PUT', body: JSON.stringify({ overrides: tidy(draft) }),
    });
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setNote('Saved. The next email that goes out uses these words.');
    await load();
  };

  const discard = () => {
    if (!data) return;
    if (!window.confirm('Throw away your unsaved changes?')) return;
    setDraft(data.overrides ?? {});
  };

  const toggle = async () => {
    if (!data) return;
    const turningOn = !data.enabled;
    if (turningOn) {
      const n = data.queue.waiting;
      const msg = n > 0
        ? `Turn the win-back email on?\n\n${n} player${n === 1 ? ' is' : 's are'} waiting. Up to ${data.queue.hourly_cap} get it each hour, starting at the top of the next hour.`
        : 'Turn the win-back email on? Nobody is waiting right now; it will send as players cross the 48-hour mark.';
      if (!window.confirm(msg)) return;
    }
    setBusy('toggle'); setError(null); setNote(null);
    const res = await call('/api/admin/email/winback', { method: 'PUT', body: JSON.stringify({ enabled: turningOn }) });
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setNote(turningOn ? 'On. The first batch goes out at the top of the hour.' : 'Off. Nothing more will send.');
    await load();
  };

  const sendTest = async () => {
    setBusy('test'); setError(null); setNote(null);
    const res = await call<{ to: string }>('/api/admin/email/winback/test', {
      method: 'POST', body: JSON.stringify({ locale, mode, overrides: tidy(draft) }),
    });
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setNote(`Test sent to ${res.data.to}: the ${LOCALE_LABEL[locale]} "${MODE_LABEL[mode]}" version, as drafted.`);
  };

  if (!data) {
    return (
      <div className="aa">
        <div className="aa-head"><h2 className="aa-title">Email</h2></div>
        {error ? <div className="em-error">{error}</div> : <div className="aa-empty">Loading…</div>}
      </div>
    );
  }

  const { totals, byMode, daily, recent } = data.metrics;
  const q = data.queue;
  const maxDay = Math.max(1, ...daily.map(d => d.sent));
  const lobbyWords = (r: Payload['queue']['next']['rooms'][number]) =>
    `${r.name} (${r.n} of ${r.max_players}${r.count ? `, ${r.count} new` : ''}${r.pending ? `, ${r.pending} already invited` : ''})`;
  const nextLine = !q.enabled
    ? `Off. ${q.waiting} player${q.waiting === 1 ? '' : 's'} would be eligible.`
    : q.next.mode === 'seat'
      ? `Next run ${clock(q.next_run_ms!)}: ${q.next.count} email${q.next.count === 1 ? '' : 's'} inviting players to ${q.next.rooms.map(lobbyWords).join(', ')}.`
      : q.next.mode === 'pool'
        ? `Next run ${clock(q.next_run_ms!)}: ${q.next.count} emails gathering a new game.`
        : q.next.reason === 'invited'
          ? `Next run ${clock(q.next_run_ms!)}: holding. Every open seat already has invitations out: ${q.next.rooms.map(lobbyWords).join(', ')}.`
          : q.next.reason === 'nobody_waiting'
            ? `Next run ${clock(q.next_run_ms!)}: nobody is waiting.`
            : `Next run ${clock(q.next_run_ms!)}: holding. Nothing is open and too few are waiting to fill a game together.`;

  return (
    <div className="aa em">
      <div className="aa-head">
        <h2 className="aa-title">Win-back email</h2>
        <div className="aa-sub">
          One email, once, to anyone who signed up 48+ hours ago and never joined a game. The button seats them through Quick Join when they click.
        </div>
      </div>

      {error && <div className="em-error">{error}</div>}
      {note && <div className="em-note">{note}</div>}
      {!data.email_configured && <div className="em-error">Email sending is not set up on this server, so nothing can go out from here.</div>}

      {/* ---- the switch ---- */}
      <section className={`em-status ${data.enabled ? 'is-on' : ''}`}>
        <div className="em-status__main">
          <span className="em-status__pill"><span className="em-status__dot" aria-hidden />{data.enabled ? 'On' : 'Off'}</span>
          <span className="em-status__line">{nextLine}</span>
        </div>
        <div className="em-status__side">
          <span className="em-status__waiting"><b>{q.waiting}</b> waiting</span>
          <button type="button" className={`em-btn ${data.enabled ? '' : 'em-btn--go'}`} onClick={toggle} disabled={busy !== null}>
            {busy === 'toggle' ? '…' : data.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </section>

      {/* ---- the numbers ---- */}
      <section>
        <div className="aa-section-title">RESULTS</div>
        <div className="aa-section-note">
          Every rate is out of emails sent. Opens are approximate: some mail apps block the tracking picture, and Apple Mail loads it for everyone.
        </div>
        <div className="em-tiles">
          <Tile label="Sent" value={totals.sent} sub={totals.failed ? `${totals.failed} failed` : 'none failed'} />
          <Tile label="Opened" value={totals.opened} sub={pct(totals.opened, totals.sent)} />
          <Tile label="Clicked" value={totals.clicked} sub={pct(totals.clicked, totals.sent)} />
          <Tile label="Joined a game" value={totals.joined} sub={pct(totals.joined, totals.sent)} accent />
          <Tile label="Still playing" value={totals.playing} sub="in a game, seen in 3 days" />
          <Tile label="Unsubscribed" value={totals.unsubscribed} sub={pct(totals.unsubscribed, totals.sent)} />
        </div>
        <div className="em-split">
          {(['seat', 'pool'] as Mode[]).map(m => (
            <span key={m}>
              <b>{MODE_LABEL[m]}:</b> {byMode[m].sent} sent · {pct(byMode[m].opened, byMode[m].sent)} opened · {pct(byMode[m].clicked, byMode[m].sent)} clicked · {pct(byMode[m].joined, byMode[m].sent)} joined
            </span>
          ))}
        </div>

        <figure className="em-chart" aria-label="Emails sent per day, last 14 days">
          <figcaption className="em-chart__title">Emails sent per day · last 14 days</figcaption>
          <div className="em-chart__plot" role="list">
            {daily.map(d => (
              <div
                key={d.day}
                role="listitem"
                className="em-chart__col"
                tabIndex={0}
                aria-label={`${d.day}: ${d.sent} sent, ${d.opened} opened, ${d.clicked} clicked`}
              >
                <div className="em-chart__tip">
                  <b>{d.day}</b><br />{d.sent} sent · {d.opened} opened · {d.clicked} clicked
                </div>
                <div className="em-chart__bar" style={{ height: `${(d.sent / maxDay) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="em-chart__axis">
            <span>{daily[0]?.day.slice(5)}</span>
            <span>{daily[daily.length - 1]?.day.slice(5)}</span>
          </div>
        </figure>
      </section>

      {/* ---- the editor ---- */}
      <section>
        <div className="aa-section-title">
          THE EMAIL
          <span className="em-seg" role="tablist" aria-label="Language">
            {data.locales.map(L => (
              <button key={L} type="button" role="tab" aria-selected={locale === L}
                className={locale === L ? 'is-on' : ''} onClick={() => setLocale(L)}>{LOCALE_LABEL[L]}</button>
            ))}
          </span>
          <span className="em-seg" role="tablist" aria-label="Version">
            {(['seat', 'pool'] as Mode[]).map(m => (
              <button key={m} type="button" role="tab" aria-selected={mode === m}
                className={mode === m ? 'is-on' : ''} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
            ))}
          </span>
        </div>
        <div className="aa-section-note">
          Leave a box empty to use the default (shown faintly). Changes apply to {LOCALE_LABEL[locale]} only.
          Words in braces, like {'{name}'}, are filled in per email.
        </div>

        <div className="em-edit">
          <div className="em-fields">
            {data.fields.map(f => {
              const value = draft[locale]?.[f.key] ?? '';
              const overridden = value.trim() !== '';
              const long = f.key.endsWith('.l1') || f.key.endsWith('.l2') || f.key.endsWith('autostart') || f.key.endsWith('.host');
              return (
                <label key={f.key} className={`em-field ${overridden ? 'is-set' : ''}`}>
                  <span className="em-field__label">
                    {f.label}
                    {f.vars.length > 0 && <span className="em-field__vars">{f.vars.map(v => `{${v}}`).join(' ')}</span>}
                    {overridden && (
                      <button type="button" className="em-field__reset" onClick={e => { e.preventDefault(); resetField(f.key); }}>
                        Reset
                      </button>
                    )}
                  </span>
                  <textarea
                    rows={long ? 3 : 1}
                    value={value}
                    placeholder={f.defaults[locale]}
                    maxLength={data.max_chars}
                    onChange={e => setField(f.key, e.target.value)}
                  />
                </label>
              );
            })}
            <label className={`em-field ${draft.hero_src?.trim() ? 'is-set' : ''}`}>
              <span className="em-field__label">
                Header picture (all languages)
                {draft.hero_src?.trim() && (
                  <button type="button" className="em-field__reset" onClick={e => { e.preventDefault(); setDraft(d => ({ ...d, hero_src: '' })); }}>
                    Reset
                  </button>
                )}
              </span>
              <input
                type="url"
                value={draft.hero_src ?? ''}
                placeholder={data.hero_default}
                onChange={e => setDraft(d => ({ ...d, hero_src: e.target.value }))}
              />
            </label>

            <div className="em-actions">
              <button type="button" className="em-btn em-btn--go" onClick={save} disabled={!dirty || busy !== null}>
                {busy === 'save' ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" className="em-btn" onClick={discard} disabled={!dirty || busy !== null}>Discard</button>
              <button type="button" className="em-btn" onClick={sendTest} disabled={busy !== null || !data.email_configured}>
                {busy === 'test' ? 'Sending…' : 'Send test to me'}
              </button>
              {dirty && <span className="em-dirty">Unsaved changes</span>}
              {!dirty && data.updated_ms && (
                <span className="em-saved">Last saved {ago(now, data.updated_ms)}{data.updated_by ? ` by ${data.updated_by}` : ''}</span>
              )}
            </div>
          </div>

          <div className="em-preview">
            <div className="em-preview__meta">
              <div><span>Subject</span>{preview?.subject ?? '…'}</div>
              <div><span>Preview text</span>{preview?.preheader ?? '…'}</div>
              {mode === 'seat' && preview?.room_source && (
                <div className="em-preview__src">
                  {preview.room_source === 'live' ? 'Showing the lobby the next run would name.' : 'No lobby is open right now, so this shows a sample.'}
                </div>
              )}
            </div>
            {previewError && <div className="em-error">{previewError}</div>}
            <iframe className="em-preview__frame" title="Email preview" srcDoc={preview?.html ?? ''} sandbox="" />
          </div>
        </div>
      </section>

      {/* ---- who got it ---- */}
      <section>
        <div className="aa-section-title">RECENT SENDS</div>
        {recent.length === 0 ? (
          <div className="aa-empty">Nothing sent yet.</div>
        ) : (
          <div className="aa-scroll-x">
            <table className="aa-table em-table">
              <thead>
                <tr><th>Player</th><th>Invited to</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Joined</th><th>Playing</th></tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} className={r.ok ? '' : 'em-row--failed'}>
                    <td title={r.email ?? ''}>{r.name}{r.unsubscribed && <span className="em-tag">unsubscribed</span>}</td>
                    <td>{r.mode === 'pool' ? 'A new game' : (r.room_name ?? 'An open game')}</td>
                    <td>{r.ok ? ago(now, r.sent_ms) : <span className="em-bad">failed: {r.error}</span>}</td>
                    <td>{r.opened_ms ? `${ago(now, r.opened_ms)}${r.open_count > 1 ? ` ×${r.open_count}` : ''}` : '—'}</td>
                    <td>
                      {r.clicked_ms ? ago(now, r.clicked_ms) : '—'}
                      {r.signed_in && <span className="em-tag em-tag--ok" title="Signed in with the email's button">by link</span>}
                    </td>
                    <td>{r.joined_ms ? <span className="em-good">{ago(now, r.joined_ms)}</span> : '—'}</td>
                    <td>{r.playing ? <span className="em-good">yes</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: number; sub: string; accent?: boolean }> = ({ label, value, sub, accent }) => (
  <div className={`em-tile ${accent ? 'em-tile--accent' : ''}`}>
    <div className="em-tile__label">{label}</div>
    <div className="em-tile__value">{value}</div>
    <div className="em-tile__sub">{sub}</div>
  </div>
);
