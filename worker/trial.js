// ============================================================
// Play for Free — a trial game with no sign-up (Lorne, 2026-10-24).
//
// A visitor clicks Play for Free and is in a game seconds later. No
// account form: the server makes a SHADOW account (users.shadow = 1), a
// session for it, and a trial solo game:
//   - 30 s ticks, two neighbours shown on the roster: an Ally and a
//     Warlord. Loose play (Peaceful sharpness); the Warlord comes for
//     them from tick 20, about ten minutes in (his pick).
//   - it starts PAUSED: the trial tutorial runs on its own (client, trial
//     track) and its last step starts the clock; until then no tick runs
//     and no computer empire moves or makes offers.
//
// SAVING IS A MERGE. When a shadow session signs up, signs in, or signs
// in with Google, claimShadow() moves the trial game into that account,
// new or existing, and retires the shadow (users.shadow = 2). The game
// itself never changes: same room, same faction, same empire.
//
// A shadow account plays its trial and nothing else: hosting, joining,
// Quick Join, another solo game and the Commission checkout answer
// account_required (index.js SHADOW_BLOCKED), and the client opens the
// save sheet. Nothing is ever emailed to it (email.js UNDELIVERABLE) and
// it is not a signup in the dashboard until it is saved (analytics.js
// QA_DOMAINS).
//
// A trial nobody is playing pauses after TRIAL_IDLE_MS without the
// player (the cron's sweepIdleTrials), so computer empires do not play
// for nobody all night; it resumes on the player's next /state.
// ============================================================

import { newUserId, createSession, sessionCookie, readSessionCookie, lookupSession } from './auth.js';
import { createSoloGame } from './solo.js';
import { stampSignupSource } from './attribution.js';
import { logEvent } from './analytics.js';
import { SHIP_COMBAT_STATS } from './factions.js';
import { tr, pickLocale, localeFromAcceptLanguage } from './i18n.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const err = (status, code, message) => json({ error: { code, message } }, { status });
async function readJson(req) { try { return await req.json(); } catch { return null; } }

export const SHADOW_DOMAIN = 'shadow.orbital.local';
const SHADOW_PASSWORD_SENTINEL = '!shadow-account-no-password-login';
/** Trials started per IP per hour. Schools, offices and phone carriers put
 *  many players behind one address, so not 6 (2026-10-24). Staging raises
 *  it further: its testers share one address (env TRIALS_PER_HOUR). */
const TRIALS_PER_HOUR = 30;
/** A trial's head start, on top of every empire's starter ships (his
 *  pick, 2026-10-24): three corvettes to defend with, a freighter to haul.
 *  Named "<name> of <World>" like the starter fleet; the client's
 *  shipNameIn (src/i18n/names.ts) translates exactly that shape, so a
 *  name here is one word plus at most a roman numeral. */
const TRIAL_FLEET = [
  { class: 'corvette', name: 'Lancer I', fuelMax: 600 },
  { class: 'corvette', name: 'Lancer II', fuelMax: 600 },
  { class: 'corvette', name: 'Lancer III', fuelMax: 600 },
  { class: 'freighter', name: 'Packhorse', fuelMax: 1200 },
];

/** The trial's extra ships, parked at the player's capital like the
 *  starter fleet (factions.js seedGameWorld). */
async function giveTrialFleet(env, gameId, userId) {
  const f = await env.DB.prepare(
    `SELECT f.id, f.capital_body_id, b.radius, b.name AS world
       FROM game_factions f JOIN game_bodies b ON b.id = f.capital_body_id
      WHERE f.game_id = ? AND f.user_id = ?`,
  ).bind(gameId, userId).first();
  if (!f) return;
  const r = Number(f.radius) || 5;
  await env.DB.batch(TRIAL_FLEET.map((ship, i) => {
    const stats = SHIP_COMBAT_STATS[ship.class] ?? { hp: 50, damage_per_tick: 0 };
    return env.DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, home_body_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, 'active', 0, ?, ?, ?, ?)`,
    ).bind(
      `${gameId}:trial_${i}`, gameId, f.id, `${ship.name} of ${f.world}`, ship.class, f.capital_body_id,
      r * 1.5, r * 2.0, (i + 1) * 1.3, (i + 1) * 2.1,
      ship.fuelMax, ship.fuelMax, stats.hp, stats.hp, stats.damage_per_tick, f.capital_body_id,
    );
  }));
}
/** A trial pauses after this long without its player. */
export const TRIAL_IDLE_MS = 15 * 60_000;
/** The trial's game, his picks. */
const TRIAL_GAME = { rivals: 2, difficulty: 'peaceful', speed_ms: 30_000, personalities: ['ally', 'warlord'] };

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The trial game this shadow user is playing, if any. */
async function trialOf(env, userId) {
  return env.DB.prepare(
    `SELECT g.id FROM games g JOIN room_members m ON m.room_id = g.id
      WHERE m.user_id = ? AND g.trial = 1 AND g.status = 'active'
      ORDER BY g.created_at DESC LIMIT 1`,
  ).bind(userId).first();
}

// POST /api/trial   { attribution? }
// -> { ok, game_id, user }, and the shadow session cookie.
export async function handleStart(req, env, session) {
  // Already in: a shadow player gets their trial back; a real account has
  // no business here (the client never offers it).
  if (session?.shadow === 1) {
    const g = await trialOf(env, session.user_id);
    if (g) return json({ ok: true, game_id: g.id, resumed: true, user: { id: session.user_id, display_name: session.display_name, shadow: 1 } });
  } else if (session) {
    return err(409, 'signed_in', 'already signed in');
  }

  // Rate limit by hashed IP: a trial is a whole game on the server.
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = await sha256(`trial:${ip}`);
  const now = Date.now();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM trial_starts WHERE ip_hash = ? AND created_at_ms > ?',
  ).bind(ipHash, now - 3_600_000).first();
  if (Number(recent?.n ?? 0) >= (Number(env.TRIALS_PER_HOUR) || TRIALS_PER_HOUR)) {
    // Counted on the dashboard: a limit that turns real visitors away
    // (a school, a phone carrier) should be seen, not guessed.
    await logEvent(env, { kind: 'trial_refused' });
    return err(429, 'too_many_trials', 'too many trial games from here; try again later');
  }

  const body = (await readJson(req)) ?? {};
  const id = newUserId();
  const email = `shadow+${id}@${SHADOW_DOMAIN}`;
  // The stand-in name is in the player's language ("Comandante"): it is on
  // screen from the first second. The app sends the language it is showing;
  // the browser's is the fallback. Saved as their language too, so the
  // account they save into keeps it.
  const locale = pickLocale(body.lang, localeFromAcceptLanguage(req.headers.get('accept-language')));
  const displayName = tr(locale, 'trial.defaultName');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, created_at, last_login_at, shadow, locale)
                    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(id, email, displayName, SHADOW_PASSWORD_SENTINEL, now, now, locale),
    env.DB.prepare('INSERT INTO trial_starts (ip_hash, created_at_ms) VALUES (?, ?)').bind(ipHash, now),
  ]);
  // Where they came from rides along to the account they save into.
  try { await stampSignupSource(env.DB, id, body.attribution, { trial: true }); } catch { /* never blocks */ }

  const made = await createSoloGame(env, id, TRIAL_GAME, { trial: true });
  if (made.error) return made.error;
  await giveTrialFleet(env, made.id, id);
  // The clock waits for the tutorial (Lorne, 2026-10-24): no ticks and no
  // computer empire moves until its last step, Start the clock (or a skip).
  await env.DB.prepare('UPDATE games SET paused = 1, auto_paused = 0, next_tick_at = NULL WHERE id = ?')
    .bind(made.id).run();
  // A returning trial player opens straight into it.
  await env.DB.prepare('UPDATE users SET autoload_room_id = ? WHERE id = ?').bind(made.id, id).run();
  const { token, expiresAt } = await createSession(env.DB, id, req.headers.get('user-agent'));
  // Awaited: a promise left running after the response is cut off, and
  // these two events are what the dashboard follows a trial by.
  await logEvent(env, { gameId: made.id, userId: id, kind: 'trial_start' });
  return json(
    { ok: true, game_id: made.id, user: { id, display_name: displayName, shadow: 1 } },
    { status: 201, headers: { 'set-cookie': sessionCookie(token, expiresAt) } },
  );
}

/**
 * SAVE: move the caller's shadow trial into `targetUserId`. Called by
 * signup, login and Google sign-in (index.js) once they have the account,
 * with the request that still carries the shadow session. A no-op for
 * anyone without one. Never throws: a failed merge must not fail the
 * sign-in (the shadow keeps its game; the client offers the save again).
 */
export async function claimShadow(env, req, targetUserId, how = 'signup') {
  try {
    const shadow = await lookupSession(env.DB, readSessionCookie(req));
    if (!shadow || Number(shadow.shadow) !== 1 || shadow.user_id === targetUserId) return null;
    const from = shadow.user_id;
    const now = Date.now();
    const trial = await trialOf(env, from);
    await env.DB.batch([
      env.DB.prepare('UPDATE room_members SET user_id = ? WHERE user_id = ?').bind(targetUserId, from),
      env.DB.prepare('UPDATE game_factions SET user_id = ? WHERE user_id = ?').bind(targetUserId, from),
      env.DB.prepare('UPDATE rooms SET host_id = ? WHERE host_id = ?').bind(targetUserId, from),
      env.DB.prepare('UPDATE users SET shadow = 2, shadow_claimed_ms = ?, shadow_claimed_by = ?, autoload_room_id = NULL WHERE id = ?').bind(now, targetUserId, from),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(from),
      // The saved game opens on their next launch, unless they already
      // chose one.
      ...(trial ? [env.DB.prepare('UPDATE users SET autoload_room_id = COALESCE(autoload_room_id, ?) WHERE id = ?').bind(trial.id, targetUserId)] : []),
    ]);
    // The room's member list (the Durable Object's copy) follows.
    if (trial) {
      try {
        await env.ROOM.get(env.ROOM.idFromName(trial.id)).fetch('https://room/member-renamed', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: targetUserId }),
        });
      } catch { /* the room re-reads D1 on its own */ }
      await env.DB.prepare('UPDATE games SET state_version = state_version + 1 WHERE id = ?').bind(trial.id).run();
    }
    // How they saved, and whether into a brand-new account (made in this
    // same request) or one they already had.
    const target = await env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(targetUserId).first();
    const fresh = !!target && now - Number(target.created_at) < 5 * 60_000;
    await logEvent(env, {
      gameId: trial?.id ?? null, userId: targetUserId, kind: 'trial_claim',
      payload: { kind: how, result: fresh ? 'new' : 'existing' },
    });
    return { from, gameId: trial?.id ?? null };
  } catch (e) {
    console.error('claimShadow failed', e);
    return null;
  }
}

/** The trial player is here: note it (once a minute, from the /state
 *  poll), and wake a trial the idle sweep paused. */
export async function touchTrial(env, gameId, now = Date.now()) {
  const woke = await env.DB.prepare(
    `UPDATE games SET paused = 0, auto_paused = 0, host_seen_ms = ?,
            next_tick_at = ? + COALESCE(tick_interval_ms, 30000), state_version = state_version + 1
      WHERE id = ? AND trial = 1 AND auto_paused = 1`,
  ).bind(now, now, gameId).run();
  if (woke?.meta?.changes > 0) {
    try {
      await env.ROOM.get(env.ROOM.idFromName(gameId)).fetch('https://room/rearm', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId }),
      });
    } catch (e) { console.error('trial rearm failed', e); }
    return;
  }
  await env.DB.prepare('UPDATE games SET host_seen_ms = ? WHERE id = ? AND trial = 1').bind(now, gameId).run();
}

/** The cron: pause trials nobody is playing. A player who paused it
 *  themselves (paused = 1, auto_paused = 0) is left alone. */
export async function sweepIdleTrials(env, now = Date.now()) {
  await env.DB.prepare(
    `UPDATE games SET paused = 1, auto_paused = 1, next_tick_at = NULL, state_version = state_version + 1
      WHERE trial = 1 AND status = 'active' AND COALESCE(paused, 0) = 0
        AND COALESCE(host_seen_ms, 0) < ?`,
  ).bind(now - TRIAL_IDLE_MS).run();
}
