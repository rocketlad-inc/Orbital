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

const AUTHORIZE = 'https://discord.com/api/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const ME = 'https://discord.com/api/v10/users/@me';

/** State TTL: long enough to authorise, short enough that a leaked link
 *  is useless. */
const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri(env, url) {
  const origin = env.PUBLIC_ORIGIN || `${url.protocol}//${url.host}`;
  return `${origin.replace(/\/+$/, '')}/api/discord/oauth/callback`;
}

function page(title, body, ok = true) {
  // Deliberately a full page, not JSON: this is the end of a browser
  // redirect chain, so a human is looking at it.
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
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
     <p><a href="/">Return to Orbital</a></p>
     </div></body></html>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/**
 * GET /api/discord/oauth/start — session-authed. Mints a state token and
 * bounces the player to Discord.
 */
export async function handleOauthStart(req, env, { session, url }) {
  if (!session) return new Response('sign in first', { status: 401 });
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return page('Discord sign-in not configured',
      'The one-click link needs a Discord client secret. Use the code method for now.', false);
  }

  // Reuse the link-code table for state: same TTL semantics, same
  // cleanup, one less thing to migrate. The 'oauth:' prefix keeps the
  // two uses from ever colliding.
  const state = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  try {
    await env.DB.prepare('DELETE FROM discord_link_codes WHERE expires_at < ?').bind(now).run();
    await env.DB
      .prepare('INSERT INTO discord_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(`oauth:${state}`, session.user_id, now + STATE_TTL_MS)
      .run();
  } catch (e) {
    console.error('oauth state store failed', e);
    return page('Could not start sign-in', 'Please try again.', false);
  }

  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
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
    return page('Sign-in cancelled', 'Nothing was linked. You can try again any time.', false);
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
  if (!userId) {
    return page('That sign-in expired', 'Head back to Orbital and press Connect Discord again.', false);
  }

  try {
    const tokenRes = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(env, url),
      }),
    });
    if (!tokenRes.ok) {
      console.error('oauth token exchange failed', tokenRes.status, await tokenRes.text().catch(() => ''));
      return page('Discord refused the sign-in', 'Please try again.', false);
    }
    const tok = await tokenRes.json();

    const meRes = await fetch(ME, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!meRes.ok) return page('Could not read your Discord account', 'Please try again.', false);
    const me = await meRes.json();
    if (!me?.id) return page('Could not read your Discord account', 'Please try again.', false);

    // Re-linking: clear this Discord id from any other account first, or
    // the partial unique index rejects the update. Same rule the /link
    // command follows.
    await env.DB
      .prepare('UPDATE users SET discord_id = NULL, discord_username = NULL WHERE discord_id = ? AND id != ?')
      .bind(me.id, userId).run();
    await env.DB
      .prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?')
      .bind(me.id, me.username ?? null, userId).run();

    return page('Discord connected',
      `You're linked as <b>${(me.username ?? 'your account').replace(/[<>&]/g, '')}</b>. ` +
      'Senate votes, alerts and trade offers will reach you there.');
  } catch (e) {
    console.error('oauth callback failed', e);
    return page('Something went wrong', 'Please try again.', false);
  }
}

export const routes = [
  { method: 'GET', pattern: '/api/discord/oauth/start', auth: 'required', handle: handleOauthStart },
  { method: 'GET', pattern: '/api/discord/oauth/callback', auth: 'none', handle: handleOauthCallback },
];
