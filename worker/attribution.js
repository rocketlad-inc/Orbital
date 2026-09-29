// ============================================================
// Where a player found the game — stamped on the account once, when
// it is created (src/multiplayer/attribution.ts collects it).
//
// Everything arrives from the browser, so nothing is trusted: each
// field is cut to a short, plain token before it touches the database.
//
// signup_source is the ONE label the admin table groups by:
//   our link tag  ?from=r-4xgaming      -> "r-4xgaming"
//   a utm tag     ?utm_source=newsletter -> "newsletter"
//   a game invite ?invite=...            -> "invite"
//   a referrer    https://www.reddit.com -> "reddit"
//   nothing at all                       -> "direct"
// signup_referrer keeps the referring site alongside a tag, so a tagged
// link that got shared somewhere else still shows where it travelled.
// ============================================================

/** Lowercase token: letters, digits, dot, dash, underscore. */
export function cleanTag(v, max = 40) {
  if (typeof v !== 'string') return null;
  const t = v.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
  return t || null;
}

// Referring hosts worth a readable name. Anything else keeps its host.
const HOSTS = [
  [/(^|\.)reddit\.com$|^redd\.it$/, 'reddit'],
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)search\.brave\.com$/, 'brave-search'],
  [/(^|\.)yahoo\.com$/, 'yahoo'],
  [/^t\.co$|(^|\.)x\.com$|(^|\.)twitter\.com$/, 'x'],
  [/(^|\.)bsky\.app$/, 'bluesky'],
  [/(^|\.)discord(app)?\.com$/, 'discord'],
  [/^news\.ycombinator\.com$/, 'hackernews'],
  [/(^|\.)itch\.io$/, 'itch'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'youtube'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, 'linkedin'],
];

/** "www.reddit.com" -> "reddit"; unknown hosts lose "www." and stay. */
export function sourceFromReferrer(host) {
  const h = cleanTag(host, 100);
  if (!h) return null;
  if (h === 'android-app') return 'android-app';
  if (h === 'play.google.com') return 'google-play';
  for (const [re, name] of HOSTS) if (re.test(h)) return name;
  return h.replace(/^www\./, '');
}

/**
 * The browser's attribution record -> the columns we store, or null
 * when there is nothing usable (an old client, or a hand-made request).
 */
export function readAttribution(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = cleanTag(raw.from);
  const utmSource = cleanTag(raw.utm_source);
  const referrer = sourceFromReferrer(raw.referrer);
  const source = from ?? utmSource ?? (raw.invite === true ? 'invite' : null) ?? referrer ?? 'direct';
  const firstSeen = Number(raw.first_seen_ms);
  return {
    source,
    campaign: cleanTag(raw.utm_campaign, 60),
    referrer,
    landing: typeof raw.landing === 'string' ? raw.landing.slice(0, 100) : null,
    first_seen_ms: Number.isFinite(firstSeen) && firstSeen > 0 ? Math.floor(firstSeen) : null,
  };
}

/**
 * Stamp a NEW account. Only ever fills an empty source, so a retry or a
 * later sign-in can't rewrite where someone came from. Best-effort: a
 * failure here must never cost a signup.
 */
export async function stampSignupSource(db, userId, raw) {
  const a = readAttribution(raw);
  if (!a) return;
  try {
    await db
      .prepare(
        `UPDATE users SET signup_source = ?, signup_campaign = ?, signup_referrer = ?,
                signup_landing = ?, signup_first_seen_ms = ?
          WHERE id = ? AND signup_source IS NULL`,
      )
      .bind(a.source, a.campaign, a.referrer, a.landing, a.first_seen_ms, userId)
      .run();
  } catch (e) {
    console.error('stampSignupSource failed', e);
  }
}
