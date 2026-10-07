// ============================================================================
// discordOauth.js — one-click account linking.
//
// The code flow asks a player to copy "/link ABC123" and paste it into
// Discord. That CANNOT WORK: Discord slash commands aren't text. You
// must type "/link", select it from the autocomplete, then fill the
// option field — so the pasted string posts as a plain message and
// nothing happens. Every player hit this, and the instructions could
// only ever paper over it.
//
// OAuth removes the step entirely: click a button in-game, approve on
// Discord, land back linked. No code, no command, no typing.
//
// Scope is `identify` only — we read the user's id and username, nothing
// else. No guilds, no email, no message access.
//
// The code flow stays as a fallback for anyone who'd rather not
// authorise an app, and because it still works from a phone.
// ============================================================================

import { tr, normalizeLocale, localeFromAcceptLanguage } from './i18n.js';

const AUTHORIZE = 'https://discord.com/api/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const ME = 'https://discord.com/api/v10/users/@me';

/** State TTL: long enough to authorise, short enough that a leaked link
 *  is useless. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The app's OAuth client id. It is the application id, which is PUBLIC,
 * so it need not be configured at all: the bot token the worker already
 * holds can ask Discord for it. DISCORD_CLIENT_ID still wins when set.
 * Only DISCORD_CLIENT_SECRET has to be added by hand (found 2026-10-06:
 * prod had neither, so the one-click link could never have worked).
 */
let cachedClientId = null;
export async function discordClientId(env) {
  if (env.DISCORD_CLIENT_ID) return env.DISCORD_CLIENT_ID;
  if (cachedClientId) return cachedClientId;
  if (!env.DISCORD_BOT_TOKEN) return null;
  try {
    const r = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) return null;
    cachedClientId = (await r.json())?.id ?? null;
    return cachedClientId;
  } catch { return null; }
}

function redirectUri(env, url) {
  const origin = env.PUBLIC_ORIGIN || `${url.protocol}//${url.host}`;
  return `${origin.replace(/\/+$/, '')}/api/discord/oauth/callback`;
}

/**
 * Turn a failed token exchange into the page a person should see.
 *
 * invalid_client (401) means Discord rejected ORBITAL's own credentials:
 * DISCORD_CLIENT_SECRET does not belong to the bot's application. Nothing
 * the player does can fix that, so the page must not tell them to try
 * again (a host who was told to kept retrying, sure their admin rights
 * were the problem). Anything else is usually a stale or reused code,
 * where trying again does work.
 */
export async function tokenFailurePage(tokenRes, what, logTag, L = 'en') {
  const text = await tokenRes.text().catch(() => '');
  console.error(`${logTag} token exchange failed`, tokenRes.status, text);
  // `what` names the flow ('sign-in' or 'connection'): one whole sentence
  // per flow, not a fragment dropped into a template, so a language with
  // gendered nouns can say it properly.
  const kind = what === 'connection' ? 'connection' : 'signin';
  if (tokenRes.status === 401 || /invalid_client/.test(text)) {
    return page(tr(L, `dc.oauth.cannotFinish.${kind}`), tr(L, 'dc.oauth.ourSide'), false, L);
  }
  return page(tr(L, `dc.oauth.refused.${kind}`), tr(L, 'dc.oauth.linkExpired'), false, L);
}

/**
 * The language of one of these pages. A browser lands here with no app
 * state, so: the browser's own Accept-Language first, then the signed-in
 * player's saved language when we know who they are, else English.
 */
export async function pageLocale(env, req, userId = null) {
  const fromHeader = localeFromAcceptLanguage(req?.headers?.get?.('accept-language'));
  if (fromHeader) return fromHeader;
  if (userId && env?.DB) {
    try {
      const row = await env.DB.prepare('SELECT locale FROM users WHERE id = ?').bind(userId).first();
      return normalizeLocale(row?.locale) ?? 'en';
    } catch { /* English */ }
  }
  return 'en';
}

export function page(title, body, ok = true, L = 'en') {
  // Deliberately a full page, not JSON: this is the end of a browser
  // redirect chain, so a human is looking at it.
  return new Response(
    `<!doctype html><html${L === 'en' ? '' : ` lang="${L}"`}><head><meta charset="utf-8"><title>${title}</title>
     <style>
       body{background:#070b12;color:#e7eef6;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;
            display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
       .card{max-width:420px;padding:28px 30px;border:1px solid ${ok ? '#2b8f88' : '#8a4a4a'};
             border-radius:12px;background:#0c121b;text-align:center}
       h1{font-size:19px;margin:0 0 10px;color:${ok ? '#4ecdc4' : '#ff6b6b'}}
       p{color:#93a3b8;margin:0 0 18px}
       a{color:#4ecdc4}
     </style></head><body><div class="card">
     <h1>${title}</h1><p>${body}</p>
     <p><a href="/">${tr(L, 'dc.oauth.return')}</a></p>
     </div></body></html>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/**
 * The end of the OAuth chain, with the DM question attached.
 *
 * Linking is now permission to VOTE from Discord, not permission to
 * message someone. This page poses the same choice /link does, in the
 * same words, so a player gets one consistent question whichever way
 * they came in — and neither path DMs them before they answer.
 *
 * Deliberately no auto-redirect: a page that bounces away before the
 * question is answered would be a silent "no", and the player would
 * never learn the feature existed.
 */
/** A string as a single-quoted JS literal for the inline script below. */
function jsStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/<\//g, '<\\/')}'`;
}

function consentPage(username, L = 'en') {
  return new Response(
    `<!doctype html><html${L === 'en' ? '' : ` lang="${L}"`}><head><meta charset="utf-8"><title>${tr(L, 'dc.oauth.connected')}</title>
     <style>
       body{background:#070b12;color:#e7eef6;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;
            display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
       .card{max-width:460px;padding:28px 30px;border:1px solid #2b8f88;border-radius:12px;background:#0c121b}
       h1{font-size:19px;margin:0 0 6px;color:#4ecdc4}
       p{color:#93a3b8;margin:0 0 14px}
       .opt{border:1px solid rgba(120,140,160,.3);border-radius:9px;padding:12px 14px;margin-bottom:10px}
       .opt b{color:#cdd9e4;display:block;margin-bottom:3px}
       .opt span{font-size:13.5px;color:#8a9fb3}
       button{width:100%;padding:11px;border-radius:8px;font:600 14px/1 inherit;cursor:pointer;
              border:1px solid #2b8f88;background:#12303a;color:#4ecdc4;margin-top:8px}
       button.ghost{border-color:rgba(120,140,160,.35);background:transparent;color:#93a3b8}
       button:disabled{opacity:.5;cursor:default}
       a{color:#4ecdc4}
       #done{display:none;color:#cdd9e4}
     </style></head><body><div class="card">
     <h1>${tr(L, 'dc.oauth.connected')}</h1>
     <p>${tr(L, 'dc.oauth.linkedAs', { name: `<b style="color:#cdd9e4">${username}</b>` })}</p>
     <div id="ask">
       <div class="opt"><b>${tr(L, 'dc.oauth.dmTitle')}</b><span>${tr(L, 'dc.oauth.dmBody')}</span>
         <button onclick="pick(true)">${tr(L, 'dc.consent.btnYes')}</button></div>
       <div class="opt"><b>${tr(L, 'dc.oauth.serverTitle')}</b><span>${tr(L, 'dc.oauth.serverBody')}</span>
         <button class="ghost" onclick="pick(false)">${tr(L, 'dc.consent.btnNo')}</button></div>
     </div>
     <div id="done"></div>
     <p style="margin-top:16px"><a href="/">${tr(L, 'dc.oauth.return')}</a></p>
     </div>
     <script>
       async function pick(consent){
         document.querySelectorAll('button').forEach(function(b){b.disabled=true});
         var msg;
         try{
           var r = await fetch('/api/me/dm-consent',{
             method:'POST', headers:{'content-type':'application/json'},
             credentials:'same-origin', body:JSON.stringify({consent:consent})});
           var d = await r.json();
           if(!consent) msg=${jsStr(tr(L, 'dc.oauth.msgServer'))};
           else if(d.dm_ok) msg=${jsStr(tr(L, 'dc.oauth.msgOn'))};
           else msg=${jsStr(tr(L, 'dc.oauth.msgBlocked'))};
         }catch(e){
           msg=${jsStr(tr(L, 'dc.oauth.msgFailed'))};
         }
         document.getElementById('ask').style.display='none';
         var el=document.getElementById('done');
         el.innerHTML=msg; el.style.display='block';
       }
     </script>
     </body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/**
 * GET /api/discord/oauth/start — session-authed. Mints a state token and
 * bounces the player to Discord.
 */
export async function handleOauthStart(req, env, { session, url }) {
  if (!session) return new Response('sign in first', { status: 401 });
  const clientId = await discordClientId(env);
  if (!clientId || !env.DISCORD_CLIENT_SECRET) {
    const L = await pageLocale(env, req, session.user_id);
    return page(tr(L, 'dc.oauth.notConfigured'), tr(L, 'dc.oauth.notConfiguredBody'), false, L);
  }

  // Reuse the link-code table for state: same TTL semantics, same
  // cleanup, one less thing to migrate. The 'oauth:' prefix keeps the
  // two uses from ever colliding.
  const state = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  try {
    await env.DB.prepare('DELETE FROM discord_link_codes WHERE expires_at < ?').bind(now).run();
    // created_at is NOT NULL (0035). This insert left it out, so it threw
    // on every click and the one-click link has never once worked on prod:
    // "Could not start sign-in" for everyone (found 2026-10-06; prod held
    // only typed /link codes and 4 linked players).
    await env.DB
      .prepare('INSERT INTO discord_link_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(`oauth:${state}`, session.user_id, now, now + STATE_TTL_MS)
      .run();
  } catch (e) {
    console.error('oauth state store failed', e);
    const L = await pageLocale(env, req, session.user_id);
    return page(tr(L, 'dc.oauth.cannotStart'), tr(L, 'dc.oauth.tryAgain'), false, L);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(env, url),
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',      // skip the consent screen on repeat links
  });
  return Response.redirect(`${AUTHORIZE}?${params}`, 302);
}

/** GET /api/discord/oauth/callback — Discord bounces the player here. */
export async function handleOauthCallback(req, env, { url }) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    const L = await pageLocale(env, req);
    return page(tr(L, 'dc.oauth.cancelled'), tr(L, 'dc.oauth.cancelledBody'), false, L);
  }

  // Consume the state ONCE. Deleting on read means a replayed callback
  // can't link a second account to the same approval.
  let userId = null;
  try {
    const row = await env.DB
      .prepare('SELECT user_id, expires_at FROM discord_link_codes WHERE code = ?')
      .bind(`oauth:${state}`).first();
    if (row && row.expires_at >= Date.now()) userId = row.user_id;
    await env.DB.prepare('DELETE FROM discord_link_codes WHERE code = ?')
      .bind(`oauth:${state}`).run();
  } catch (e) {
    console.error('oauth state lookup failed', e);
  }
  // The browser's language, else the signed-in player's saved one (the
  // state row told us who this is).
  const L = await pageLocale(env, req, userId);
  if (!userId) {
    return page(tr(L, 'dc.oauth.expired'), tr(L, 'dc.oauth.expiredBody'), false, L);
  }

  try {
    const tokenRes = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: await discordClientId(env),
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(env, url),
      }),
    });
    if (!tokenRes.ok) return tokenFailurePage(tokenRes, 'sign-in', 'oauth', L);
    const tok = await tokenRes.json();

    const meRes = await fetch(ME, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!meRes.ok) return page(tr(L, 'dc.oauth.cannotRead'), tr(L, 'dc.oauth.tryAgain'), false, L);
    const me = await meRes.json();
    if (!me?.id) return page(tr(L, 'dc.oauth.cannotRead'), tr(L, 'dc.oauth.tryAgain'), false, L);

    // Re-linking: clear this Discord id from any other account first, or
    // the partial unique index rejects the update. Same rule the /link
    // command follows.
    await env.DB
      .prepare('UPDATE users SET discord_id = NULL, discord_username = NULL WHERE discord_id = ? AND id != ?')
      .bind(me.id, userId).run();
    await env.DB
      .prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?')
      .bind(me.id, me.username ?? null, userId).run();

    // Linked, but not yet permitted to DM them — same rule as /link.
    // This page asks before anything reaches their inbox.
    return consentPage((me.username ?? tr(L, 'dc.oauth.yourAccount')).replace(/[<>&]/g, ''), L);
  } catch (e) {
    console.error('oauth callback failed', e);
    return page(tr(L, 'dc.oauth.wrong'), tr(L, 'dc.oauth.tryAgain'), false, L);
  }
}

export const routes = [
  { method: 'GET', pattern: '/api/discord/oauth/start', auth: 'required', handle: handleOauthStart },
  { method: 'GET', pattern: '/api/discord/oauth/callback', auth: 'none', handle: handleOauthCallback },
];
