// ============================================================
// Link and ad traffic before it signs up (0180).
//
// users.signup_source answers "where did this ACCOUNT come from", but
// says nothing about the visitors who never made one, so a paid ad
// with no signups could not be told from an ad nobody clicked. The
// browser (src/multiplayer/attribution.ts) now reports:
//
//   POST /api/visit { anon, step: 'land', a: <attribution> }
//        once per browser, on its first tagged or referred arrival
//   POST /api/visit { anon, step }   the sign-in screen's progress:
//        engaged      stayed 10 s with the page visible, or touched it
//        read_more    opened a page past the front one (how to play, ...)
//        play_click   pressed Play free / Sign in on the site
//        signup_tab   opened the Sign up tab
//        email_try    submitted the email sign-up form
//        login_try    submitted the sign-in form (an existing player)
//        google_try   Google handed back a credential
//        auth_error   the server refused a sign-up / sign-in
//        google_error the Google button itself failed (in-app browsers)
//
// The signup then stamps signup_user_id on the browser's row
// (linkVisitToUser), which joins the funnel to everything the account
// did afterwards. Anonymous, unauthenticated and fire-and-forget: every
// field is cleaned, robots are skipped, and the answer is always 204.
// ============================================================

import { cleanTag, readAttribution } from './attribution.js';

const ANON_RE = /^[A-Za-z0-9_-]{8,40}$/;
const STEPS = new Set(['engaged', 'read_more', 'play_click', 'signup_tab', 'email_try', 'login_try', 'google_try', 'auth_error', 'google_error', 'trial_click']);

// Crawlers, link unfurlers and ad reviewers. They do not run the beacon
// as a rule, but the ones that do should not count as visitors.
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|pingdom|monitor/i;

/** 'phone' | 'tablet' | 'desktop' from a User-Agent. */
export function deviceFrom(ua) {
  const s = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(s)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(s)) return 'phone';
  return 'desktop';
}

/** The app whose built-in browser this is, from its User-Agent, or null.
 *  Android apps mostly open Chrome Custom Tabs, which look like Chrome;
 *  the browser's android-app:// referrer names those (see inAppFromRef). */
export function inAppFrom(ua) {
  const s = String(ua || '');
  if (/\bReddit\b/i.test(s)) return 'reddit';
  if (/FBAN|FBAV|FB_IAB|FBIOS/.test(s)) return 'facebook';
  if (/Instagram/.test(s)) return 'instagram';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(s)) return 'tiktok';
  if (/Discord/i.test(s)) return 'discord';
  if (/Twitter|TwitterAndroid/i.test(s)) return 'x';
  if (/LinkedInApp/i.test(s)) return 'linkedin';
  if (/Snapchat/i.test(s)) return 'snapchat';
  if (/\bLine\//.test(s)) return 'line';
  if (/; wv\)/.test(s)) return 'android-webview';
  return null;
}

/** The ad networks' click ids, first one found. */
export const CLICK_IDS = [
  ['rdt_cid', 'reddit'],
  ['gclid', 'google'], ['gbraid', 'google'], ['wbraid', 'google'],
  ['fbclid', 'meta'],
  ['ttclid', 'tiktok'],
  ['msclkid', 'microsoft'],
  ['twclid', 'x'],
];

function cleanClickId(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 200);
  return t || null;
}

/** The browser's attribution record -> one campaign_visits row's fields. */
export function readVisit(raw) {
  const a = readAttribution(raw);
  if (!a) return null;
  const kind = typeof raw.click_kind === 'string' && CLICK_IDS.some(([, k]) => k === raw.click_kind) ? raw.click_kind : null;
  const id = kind ? cleanClickId(raw.click_id) : null;
  return {
    source: a.source,
    campaign: a.campaign,
    content: cleanTag(raw.utm_content, 80),
    term: cleanTag(raw.utm_term, 80),
    medium: cleanTag(raw.utm_medium, 40),
    click_kind: id ? kind : null,
    click_id: id,
    referrer: a.referrer,
    landing: a.landing,
  };
}

/** POST /api/visit — see the header. Always 204, whatever happens. */
async function handleVisit(req, env, { session }) {
  const done = new Response(null, { status: 204 });
  const ua = req.headers.get('user-agent') || '';
  if (!ua || BOT_RE.test(ua)) return done;
  const body = await req.json().catch(() => null);
  const anon = typeof body?.anon === 'string' && ANON_RE.test(body.anon) ? body.anon : null;
  if (!anon) return done;
  const now = Date.now();
  try {
    if (body.step === 'land') {
      const v = readVisit(body.a);
      if (!v) return done;
      const inApp = inAppFrom(ua) ?? (typeof body.a?.in_app === 'string' ? cleanTag(body.a.in_app, 30) : null);
      const country = typeof req.cf?.country === 'string' ? req.cf.country.slice(0, 2) : null;
      // First arrival wins; a later one only bumps the count and the time.
      await env.DB
        .prepare(
          `INSERT INTO campaign_visits
             (anon_id, source, campaign, content, term, medium, click_kind, click_id, referrer, landing,
              device, in_app, country, viewer_user_id, first_ms, last_ms, visits)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, 1)
           ON CONFLICT(anon_id) DO UPDATE SET last_ms = ?15, visits = visits + 1`,
        )
        .bind(anon, v.source, v.campaign, v.content, v.term, v.medium, v.click_kind, v.click_id,
          v.referrer, v.landing, deviceFrom(ua), inApp, country, session?.user_id ?? null, now)
        .run();
      return done;
    }
    if (!STEPS.has(body.step)) return done;
    // Only browsers that arrived through a link have a funnel to fill.
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO campaign_steps (anon_id, step, at_ms)
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM campaign_visits WHERE anon_id = ?1)`,
      )
      .bind(anon, body.step, now)
      .run();
  } catch (e) {
    console.error('visit beacon failed', e);
  }
  return done;
}

/** A new account made by this browser: join its funnel to the account.
 *  Once only, and best-effort, like the rest of signup attribution. */
export async function linkVisitToUser(db, userId, anon, { trial = false } = {}) {
  if (!userId || typeof anon !== 'string' || !ANON_RE.test(anon)) return;
  try {
    // A Play for Free trial is not a signup: it gets its own column, and
    // signup_user_id waits for the account the trial is saved into (0187).
    await db
      .prepare(trial
        ? 'UPDATE campaign_visits SET trial_user_id = ? WHERE anon_id = ? AND trial_user_id IS NULL'
        : 'UPDATE campaign_visits SET signup_user_id = ? WHERE anon_id = ? AND signup_user_id IS NULL')
      .bind(userId, anon)
      .run();
  } catch (e) {
    console.error('linkVisitToUser failed', e);
  }
}

export const routes = [
  { method: 'POST', pattern: '/api/visit', auth: 'optional', handle: handleVisit },
];
