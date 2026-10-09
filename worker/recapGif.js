// ============================================================
// recapGif — the battle replay GIF, made on the server for Discord.
//
// Lorne, 2026-10-09: "a discord bot event that posts the gif of a battle
// at its conclusion". The GIF is drawn by the recap itself, in a browser
// (src/multiplayer/recapGif.ts): there is no canvas in a Worker. So when
// a battle closes, the replay post (recapShare.js publishReplay) queues a
// job here instead of posting, and this Durable Object:
//
//   1. opens the battle's own public recap page in Cloudflare Browser
//      Rendering (headless Chrome, the BROWSER binding), with a one-time
//      job id + nonce in the URL;
//   2. the page records the GIF with the same recorder as the GIF button
//      (the whole fight, or its final ticks when the whole fight would be
//      over Discord's upload limit) and POSTs it back to
//      /api/recap/<token>/gif with that nonce;
//   3. the upload is checked against the job and posted to the game's
//      feed as ONE message: the replay embed with the GIF in it.
//
// If anything fails, or the page never uploads, the job posts the plain
// replay embed exactly as before, so a battle never loses its post.
// One job at a time, in the order battles closed: rendering is slow (a
// long fight takes minutes) and the account's browser time is shared.
// ============================================================

/** Discord's default upload limit is 10 MB; this leaves room for the
 *  message around the file. The page aims under it. */
export const GIF_MAX_BYTES = Math.floor(9.5 * 1024 * 1024);
/** A Durable Object alarm may run 15 minutes; the page gets 13. */
const RENDER_TIMEOUT_MS = 13 * 60 * 1000;
const DO_NAME = 'global';

function siteOf(env) {
  return env.ORBITAL_ENV === 'staging'
    ? 'https://orbital-staging.lcfeeser.workers.dev'
    : 'https://orbital-empire.com';
}

const stubOf = (env) => env.RECAP_GIF.get(env.RECAP_GIF.idFromName(DO_NAME));

/** Queue a battle's replay GIF. True when queued (the job will post the
 *  replay itself, with or without a GIF); false to post it now. */
export async function queueBattleGif(env, gameId, battleId, token) {
  if (!env.BROWSER || !env.RECAP_GIF) return false;
  try {
    const res = await stubOf(env).fetch('https://recap-gif/enqueue', {
      method: 'POST',
      body: JSON.stringify({ gameId, battleId, token }),
    });
    return res.ok;
  } catch (e) {
    console.error('recap gif enqueue failed', e);
    return false;
  }
}

/** POST /api/recap/<token>/gif?job=&nonce= — the recap page handing its
 *  GIF back. Everything is checked by the job's Durable Object. */
export async function handleGifUpload(req, env, token) {
  if (!env.RECAP_GIF) return new Response('not here', { status: 404 });
  const url = new URL(req.url);
  const fwd = new URL('https://recap-gif/upload');
  for (const k of ['job', 'nonce']) fwd.searchParams.set(k, url.searchParams.get(k) ?? '');
  return stubOf(env).fetch(fwd.toString(), {
    method: 'POST',
    headers: {
      'x-token': token,
      'x-gif-from': req.headers.get('x-gif-from') ?? '0',
      'x-gif-ticks': req.headers.get('x-gif-ticks') ?? '0',
      'x-gif-total': req.headers.get('x-gif-total') ?? '0',
    },
    body: req.body,
  });
}

/** The operator's view (index.js gates it on the agent key):
 *  POST dry-run {token} renders a battle's GIF on the server without
 *  posting it; GET status lists the last renders and the queue. */
export async function handleRecapGifInternal(req, env, action) {
  if (!env.RECAP_GIF) return new Response('not here', { status: 404 });
  if (action === 'status') return stubOf(env).fetch('https://recap-gif/status');
  if (action === 'dry-run' && req.method === 'POST') {
    const { token } = await req.json().catch(() => ({}));
    if (!token) return new Response('token required', { status: 400 });
    return stubOf(env).fetch('https://recap-gif/enqueue', {
      method: 'POST', body: JSON.stringify({ token, dryRun: true }),
    });
  }
  return new Response('not found', { status: 404 });
}

export class RecapGif {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const st = this.state.storage;

    if (url.pathname === '/enqueue') {
      const { gameId, battleId, token, dryRun } = await req.json();
      if (!token || (!dryRun && (!gameId || !battleId))) return new Response('bad job', { status: 400 });
      const id = crypto.randomUUID();
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
      // Keys sort by time, so jobs run in the order battles closed.
      await st.put(`job:${String(Date.now()).padStart(15, '0')}:${id}`,
        { id, nonce, gameId, battleId, token, dryRun: !!dryRun, queuedAt: Date.now() });
      if ((await st.getAlarm()) == null) await st.setAlarm(Date.now() + 1000);
      return new Response('queued');
    }

    // The last renders, newest first: what was made, how big, how long.
    if (url.pathname === '/status') {
      const rows = [...(await st.list({ prefix: 'result:', reverse: true, limit: 20 })).values()];
      const queued = (await st.list({ prefix: 'job:' })).size;
      return new Response(JSON.stringify({ queued, results: rows }, null, 2),
        { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/upload') {
      const jobId = url.searchParams.get('job') ?? '';
      const active = await st.get(`active:${jobId}`);
      if (!active || active.nonce !== url.searchParams.get('nonce')
          || active.token !== req.headers.get('x-token')) {
        return new Response('unknown job', { status: 403 });
      }
      if (active.uploaded) return new Response('already posted', { status: 409 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      const isGif = bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
      if (!isGif) return new Response('not a gif', { status: 400 });
      if (bytes.length > GIF_MAX_BYTES) return new Response('too big', { status: 413 });
      const span = {
        fromTick: Number(req.headers.get('x-gif-from')) || 0,
        ticks: Number(req.headers.get('x-gif-ticks')) || 0,
        total: Number(req.headers.get('x-gif-total')) || 0,
      };
      // A dry run (the agent-key test route) proves the render and stops
      // here: nothing is posted anywhere.
      if (active.dryRun) {
        await st.put(`active:${jobId}`, { ...active, uploaded: true, posted: false, bytes: bytes.length, span });
        return new Response('dry run: not posted');
      }
      const { replayPost, postReplay } = await import('./recapShare.js');
      const post = await replayPost(this.env, active.battleId);
      let posted = false;
      if (post) {
        const r = await postReplay(this.env, active.gameId, post,
          { name: 'battle.gif', type: 'image/gif', bytes }, span);
        posted = !!r?.posted;
      }
      await st.put(`active:${jobId}`, { ...active, uploaded: true, posted, bytes: bytes.length, span });
      console.log('recap gif posted', active.battleId, bytes.length, span, posted);
      return new Response(posted ? 'posted' : 'not posted', { status: posted ? 200 : 502 });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const st = this.state.storage;
    const next = [...(await st.list({ prefix: 'job:', limit: 1 })).entries()][0];
    if (!next) return;
    const [key, job] = next;
    await st.delete(key);
    await st.put(`active:${job.id}`, job);
    const t0 = Date.now();
    let error = null, page = null;
    try {
      page = await this.render(job);
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
      console.error('recap gif render failed', job.battleId, e);
    }
    const done = await st.get(`active:${job.id}`);
    await st.put(`result:${String(Date.now()).padStart(15, '0')}`, {
      token: job.token, battleId: job.battleId ?? null, dryRun: !!job.dryRun,
      uploaded: !!done?.uploaded, posted: !!done?.posted, bytes: done?.bytes ?? null,
      span: done?.span ?? null, ms: Date.now() - t0, page, error,
    });
    const old = [...(await st.list({ prefix: 'result:' })).keys()];
    if (old.length > 50) await st.delete(old.slice(0, old.length - 50));
    // No GIF made it: the battle still gets its replay post.
    if (!done?.posted && !job.dryRun) {
      try {
        const { replayPost, postReplay } = await import('./recapShare.js');
        const post = await replayPost(this.env, job.battleId);
        if (post) await postReplay(this.env, job.gameId, post, null, null);
      } catch (e) {
        console.error('replay fallback post failed', job.battleId, e);
      }
    }
    await st.delete(`active:${job.id}`);
    const more = await st.list({ prefix: 'job:', limit: 1 });
    if (more.size > 0) await st.setAlarm(Date.now() + 1000);
  }

  /** Open the recap page in headless Chrome and wait for it to record and
   *  upload its GIF (src/multiplayer/SharedRecap.tsx, gif job mode). */
  async render(job) {
    // Loaded here, not at the top: the replay post imports this module on
    // every battle close, and only this Durable Object ever drives Chrome.
    const { default: puppeteer } = await import('@cloudflare/puppeteer');
    const browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: 600000 });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 900 });
      const url = `${siteOf(this.env)}/recap/${encodeURIComponent(job.token)}`
        + `?gifjob=${encodeURIComponent(job.id)}&nonce=${encodeURIComponent(job.nonce)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction('window.__recapGif && window.__recapGif.done === true',
        { timeout: RENDER_TIMEOUT_MS, polling: 2000 });
      const result = await page.evaluate('JSON.stringify(window.__recapGif)');
      console.log('recap gif page', job.battleId, result);
      return result;
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
