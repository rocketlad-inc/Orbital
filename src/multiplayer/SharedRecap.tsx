// ============================================================
// SharedRecap — one battle, on a page anyone can open.
//
// A recap is the most watchable thing the game produces and it lived
// behind an admin session, so the only way to show somebody a fight was
// to describe it. This is the page behind a share link: no account, no
// lobby, no game running underneath. Just the engagement.
//
// It renders the SAME BattleRecap the analytics browser does, off the
// same payload, because a share that quietly diverged from the real
// thing is worse than no share — the whole value of sending someone a
// link is that they see what you saw.
// ============================================================

import React, { useEffect, useState } from 'react';
import { BattleRecap, type Detail as BattleDetailPayload } from './BattleReview';
import { TheatreCanvas, type TheatreDetail } from './TheatreRecap';

const NEUTRAL = '#8a9fb3';

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export function SharedRecap({ token }: { token: string }) {
  const [d, setD] = useState<BattleDetailPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The campaign this battle was part of, fetched only if the reader asks
  // for it — most shares are one engagement and the system payload is
  // every frame of every battle in the neighbourhood.
  const [system, setSystem] = useState<TheatreDetail | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [sysErr, setSysErr] = useState<string | null>(null);

  useEffect(() => {
    if (!showSystem || system) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/recap/${encodeURIComponent(token)}/system`);
        if (dead) return;
        if (!res.ok) { setSysErr('The wider campaign could not be loaded.'); return; }
        setSystem(await res.json());
      } catch {
        if (!dead) setSysErr('Could not reach the server.');
      }
    })();
    return () => { dead = true; };
  }, [showSystem, system, token]);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        // Deliberately a bare fetch rather than apiFetch: there is no
        // session here and nothing to attach to the request.
        const res = await fetch(`/api/recap/${encodeURIComponent(token)}`);
        if (dead) return;
        if (!res.ok) {
          setErr(res.status === 404
            ? 'This recap link is not valid, or has been turned off.'
            : `Could not load this recap (HTTP ${res.status}).`);
          return;
        }
        setD(await res.json());
      } catch {
        if (!dead) setErr('Could not reach the server.');
      }
    })();
    return () => { dead = true; };
  }, [token]);

  const b = d?.battle;
  const span = b ? (b.ended_tick ?? b.last_fire_tick) - b.started_tick + 1 : 0;
  // Only worth offering when the campaign was bigger than this fight. A
  // theatre of one is the recap already on the page.
  const wider = !!d?.theatre && d.theatre.battle_count > 1;

  useEffect(() => {
    if (b) document.title = `${b.body_name ?? 'Deep space'} — Orbital battle recap`;
  }, [b]);

  return (
    <div className="shared-recap">
      <div className="shared-recap__inner">
        <a className="shared-recap__brand" href="/">ORBITAL</a>

        {err && <div className="shared-recap__err">{err}</div>}
        {!d && !err && <div className="shared-recap__loading">Loading the recap…</div>}

        {d && b && (
          <>
            <h1 className="shared-recap__title">
              {b.body_name ?? 'Deep space'}
              <span className="shared-recap__tick">T+{b.started_tick}–{b.ended_tick ?? b.last_fire_tick}</span>
            </h1>

            <div className="shared-recap__sides">
              {d.sides.map(s => (
                <span key={s.faction_id} className="shared-recap__side"
                  style={{ borderColor: s.color ?? NEUTRAL, color: s.color ?? NEUTRAL }}>
                  {s.name}
                  <b style={{ color: '#cfe0ee' }}>
                    {' '}{s.committed - s.lost}/{s.committed}
                  </b>
                </span>
              ))}
            </div>

            {wider && (
              <div className="shared-recap__campaign">
                <span>
                  One engagement in the fight for{' '}
                  <b>{d.theatre!.anchor_name ?? 'this system'}</b> —{' '}
                  {d.theatre!.battle_count} of them between T+{d.theatre!.started_tick} and
                  {' '}T+{d.theatre!.last_fire_tick}.
                </span>
                <button onClick={() => setShowSystem(v => !v)}>
                  {showSystem ? 'Show this engagement' : 'Watch the whole system'}
                </button>
              </div>
            )}

            {showSystem
              ? (sysErr
                ? <div className="shared-recap__err">{sysErr}</div>
                : system
                  ? <TheatreCanvas d={system} />
                  : <div className="shared-recap__loading">Loading the campaign…</div>)
              : <BattleRecap d={d} />}

            <div className="shared-recap__stats">
              {span} tick{span === 1 ? '' : 's'} · {b.shots} shots · {pct(b.hits, b.shots)}% hit
              {b.ships_lost > 0 && <> · <b style={{ color: '#ff8a80' }}>{b.ships_lost} lost</b></>}
              {b.victor && <> · victor <b>{b.victor.name}</b></>}
            </div>

            <div className="shared-recap__foot">
              Every shot in this recap was recorded as it happened.{' '}
              <a href="/">Play Orbital</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
