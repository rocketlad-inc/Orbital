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
function consentPage(username) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Discord connected</title>
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
     <h1>Discord connected</h1>
     <p>Linked as <b style="color:#cdd9e4">${username}</b>. You can vote on Senate bills from
     the channel either way — one more question:</p>
     <div id="ask">
       <div class="opt"><b>📬 Send me direct messages</b><span>Your 6pm situation report,
         a nudge when a vote is closing without you, and messages from other factions.</span>
         <button onclick="pick(true)">Yes, DM me</button></div>
       <div class="opt"><b>🔕 Server only</b><span>Nothing in your inbox. Senate cards, the
         Orbital Herald and every slash command still work exactly the same.</span>
         <button class="ghost" onclick="pick(false)">Server only</button></div>
     </div>
     <div id="done"></div>
     <p style="margin-top:16px"><a href="/">Return to Orbital</a></p>
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
           if(!consent) msg='🔕 <b>Server only.</b> Nothing will reach your inbox. You can change this any time in the Notifications panel.';
           else if(d.dm_ok) msg='📬 <b>DMs on.</b> A welcome message is waiting in your Discord inbox.';
           else msg='⚠️ You are opted in, but Discord <b>blocked the test message</b>. Right-click the server icon &rarr; Privacy Settings &rarr; enable Direct Messages. Everything still reaches you in the channel meanwhile.';
         }catch(e){
           msg='Could not save that. Set it in-game under Notifications.';
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

    // Linked, but not yet permitted to DM them — same rule as /link.
    // This page asks before anything reaches their inbox.
    return consentPage((me.username ?? 'your account').replace(/[<>&]/g, ''));
  } catch (e) {
    console.error('oauth callback failed', e);
    return page('Something went wrong', 'Please try again.', false);
  }
}

export const routes = [
  { method: 'GET', pattern: '/api/discord/oauth/start', auth: 'required', handle: handleOauthStart },
  { method: 'GET', pattern: '/api/discord/oauth/callback', auth: 'none', handle: handleOauthCallback },
];
