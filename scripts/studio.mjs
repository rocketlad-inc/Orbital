#!/usr/bin/env node
// ============================================================================
// studio.mjs — the video studio from the command line, for agents.
//
//   node scripts/studio.mjs catalog                      [--env staging]
//   node scripts/studio.mjs apply  scene.json            [--env staging] [--game <id>]
//   node scripts/studio.mjs tick   <gameId> [n]          [--env staging]
//   node scripts/studio.mjs record <gameId> shot.json --out clip.mp4
//                                  [--as studio-terra] [--size 1080x1920] [--env staging]
//   node scripts/studio.mjs eval   <gameId> "await __studio.ticks(1)" [--as studio-terra]
//   node scripts/studio.mjs close  <gameId>              [--env staging]
//
// A SCENE (worker/studioScene.js) fills a private test game with ships,
// cities, wars, fleets and orders. A SHOT (src/multiplayer/studio/
// director.ts) moves the camera over it and records the map to a video.
// `record` opens the game in headless Chrome as one of the scene's agent
// players, hands the shot to window.__studio, and pulls the video back
// out over the DevTools protocol. `eval` opens the game the same way and
// runs a line of JavaScript in it, for checking a target or a tick by
// hand. No dependencies: Node's own fetch and WebSocket, and the Chrome
// already on the machine.
//
// CREDENTIALS never print. The agent key is read from ~/.orbital-agent-key
// (production) or ~/.orbital-staging-agent-key (staging); it goes in the
// X-Agent-Key header of every call, and mints the viewer's session.
//
// The manual, with the scene and shot languages: docs/STUDIO.md.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

class Fail extends Error {}
const die = (m) => { throw new Fail(m); };

const argv = process.argv.slice(2);
const flag = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [cmd, ...rest] = positional;

const ENV = flag('env', process.env.ORBITAL_ENV || 'staging');
const BASE = ENV === 'production' || ENV === 'prod' ? 'https://orbital-empire.com' : 'https://orbital-staging.lcfeeser.workers.dev';
const KEY_FILE = path.join(os.homedir(), ENV === 'production' || ENV === 'prod' ? '.orbital-agent-key' : '.orbital-staging-agent-key');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function key() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { die(`no agent key at ${KEY_FILE}`); }
}

/** Mint (and cache for the run) a session for an agent handle. */
const sessions = new Map();
async function session(handle) {
  if (sessions.has(handle)) return sessions.get(handle);
  const res = await fetch(`${BASE}/api/agent/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-key': key() },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) die(`could not mint a session for ${handle} (${res.status}); is AGENT_KEY set on ${ENV}?`);
  const d = await res.json();
  sessions.set(handle, d.token);
  return d.token;
}

async function api(method, p, body, handle = 'studio-cli') {
  const token = await session(handle);
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-agent-key': key() },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) die(`${method} ${p} -> ${res.status} ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data.error ?? data).slice(0, 300)}`);
  return data;
}

const strip = (id) => (typeof id === 'string' ? id.replace(/^[^:]+:/, '') : id);

// ---------- commands ----------

async function catalog() {
  const c = await api('GET', '/api/admin/studio/catalog');
  console.log(JSON.stringify({ classes: c.classes, loadouts: c.loadouts, emblems: c.emblems,
    start_worlds: c.bodies.filter(b => b.start).map(b => b.id), worlds: c.bodies.map(b => b.id), examples: Object.keys(c.examples) }, null, 2));
}

async function apply() {
  const file = rest[0] || die('apply needs a scene.json');
  const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (flag('game')) scene.game_id = flag('game');
  delete scene.seat_me;   // the CLI has no human to seat
  const out = await api('POST', '/api/admin/studio/games', scene);
  // Ids as the map knows them (the game prefix stripped), ready for shots.
  const ships = Object.fromEntries(Object.entries(out.ships).map(([k, ids]) => [k, ids.map(strip)]));
  const fleets = Object.fromEntries(Object.entries(out.fleets).map(([k, id]) => [k, strip(id)]));
  console.log(JSON.stringify({ game_id: out.game_id, created: out.created, tick: out.tick, viewer: out.viewer,
    factions: out.factions.map(f => ({ key: f.key, handle: f.handle, id: strip(f.id) })),
    ships, fleets, wars: out.wars, orders: out.orders,
    ...(out.megastructures?.length ? { megastructures: out.megastructures } : {}),
    ...(out.kaiju ? { kaiju: out.kaiju } : {}),
    ...(out.gate_birth ? { gate_birth: out.gate_birth } : {}),
    warnings: out.warnings ?? [] }, null, 2));
  for (const w of out.warnings ?? []) console.error(`WARNING: ${w}`);
  if (out.created) console.error(`\nScene applied to NEW game ${out.game_id}. Record with:\n  node scripts/studio.mjs record ${out.game_id} shot.json --out clip.mp4 --as ${out.factions.find(f => f.key === out.viewer)?.handle ?? out.factions[0].handle}${ENV !== 'staging' ? ` --env ${ENV}` : ''}`);
}

async function tick() {
  const [gameId, n] = rest;
  if (!gameId) die('tick needs a game id');
  const out = await api('POST', `/api/admin/studio/games/${gameId}/tick`, { n: Number(n) || 1 });
  console.log(JSON.stringify({ from: out.from, current_tick: out.current_tick }));
}

async function close() {
  const [gameId] = rest;
  if (!gameId) die('close needs a game id');
  await api('POST', `/api/admin/studio/games/${gameId}/close`, {});
  console.log(`closed ${gameId}`);
}

// ---------- headless Chrome over the DevTools protocol ----------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function launchChrome(port, width, height) {
  const profile = path.join(os.tmpdir(), `orbital-studio-${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    `--window-size=${width},${height}`, '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    await sleep(250);
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* not yet */ }
  }
  if (!ver) { proc.kill(); die('Chrome did not start; set CHROME to its path'); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };
  // Every call can carry a deadline. A screenshot or a frame that never
  // answers used to stall a take for an hour with nothing in the log.
  const send = (method, params = {}, timeoutMs = 0) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method}: no answer in ${timeoutMs / 1000} s`)); }
      }, timeoutMs);
    }
  });
  const evaluate = async (expression, timeoutMs = 0) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  const close = async () => {
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const b = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise(r => { b.onopen = r; });
      b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(400);
    } catch { /* already gone */ }
    try { proc.kill(); } catch { /* gone */ }
    try { ws.close(); } catch { /* gone */ }
  };
  return { send, evaluate, close };
}

/** Headless Chrome with the game open as an agent player and window.__studio attached. */
async function openGame(gameId, handle, w, h) {
  const token = await session(handle);
  const port = 9400 + Math.floor(Math.random() * 400);
  const b = await launchChrome(port, w, h);
  try {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await b.send('Emulation.setEmulatedMedia', { features: [
      { name: 'pointer', value: 'fine' }, { name: 'any-pointer', value: 'fine' }, { name: 'hover', value: 'hover' }, { name: 'any-hover', value: 'hover' }] });
    const host = new URL(BASE).hostname;
    const boot = [
      `try { if (location.hostname === ${JSON.stringify(host)}) {`,
      `  sessionStorage.setItem('orbital_agent_token', ${JSON.stringify(token)});`,
      // The room this tab opens (App.tsx tabRoom). The agent player may sit
      // in several studio games; without this the app picks one itself.
      `  sessionStorage.setItem('orbital.tab_room', ${JSON.stringify(gameId)});`,
      `  localStorage.setItem('orbital.tutorial.v1', JSON.stringify({ completed: true, skipped: true }));`,
      `} } catch (e) {}`,
    ].join('\n');
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: boot });
    await b.send('Page.navigate', { url: `${BASE}/` });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      await sleep(1000);
      ready = await b.evaluate(`!!(window.__studio && document.querySelector('canvas.map-canvas'))`).catch(() => false);
    }
    if (!ready) die('the game did not open with the studio attached: is the handle a member of this game, and is it an admin-visible studio game?');
    const opened = await b.evaluate('window.__studio.gameId');
    if (opened !== gameId) die(`the app opened game ${opened}, not ${gameId}; is ${handle} seated in ${gameId}?`);
    await sleep(6000);   // first paint, art, the state poll
    return b;
  } catch (e) { await b.close(); throw e; }
}

/** What the shot will get wrong in this game, before a frame is spent on
 *  it (Director.check: a strike step that fires while its Mega Destroyer
 *  is still in flight does nothing). Warns; --strict stops the take. */
async function warnShot(b, shot) {
  const found = JSON.parse(await b.evaluate(`JSON.stringify(window.__studio.check ? window.__studio.check(${JSON.stringify(shot)}) : [])`).catch(() => '[]'));
  for (const w of found) console.error(`WARNING: ${w}`);
  if (found.length && process.argv.includes('--strict')) die('the shot has problems (--strict)');
}

async function record() {
  const [gameId, shotFile] = rest;
  if (!gameId || !shotFile) die('record needs <gameId> shot.json --out clip.mp4');
  const out = flag('out') || `orbital-${gameId}.mp4`;
  const shot = JSON.parse(fs.readFileSync(shotFile, 'utf8'));
  const [w, h] = (flag('size') || (shot.format === '16:9' ? '1920x1080' : shot.format === '1:1' ? '1080x1080' : '1080x1920')).split('x').map(Number);
  const handle = flag('as') || 'studio-terra';
  const b = await openGame(gameId, handle, w, h);
  try {
    await warnShot(b, shot);
    console.error(`recording ${shot.seconds}s at ${w}x${h} as ${handle}…`);
    await b.evaluate(`(() => { window.__studioDone = null; window.__studio.record(${JSON.stringify(shot)}, { download: false })
      .then(() => { window.__studioDone = window.__studio.result; }, e => { window.__studioDone = { ok: false, error: String(e && e.message || e) }; }); return true; })()`);
    let done = null;
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 30 * 60_000) {
      await sleep(2000);
      const st = await b.evaluate(`JSON.stringify({ p: window.__studio.progress, d: window.__studioDone })`);
      const { p, d } = JSON.parse(st);
      if (d) done = d; else process.stderr.write(`\r  ${Math.round(p * 100)}%   `);
    }
    process.stderr.write('\n');
    if (!done?.ok) die(`recording failed: ${done?.error ?? 'timed out'}`);
    const chunks = [];
    for (let i = 0; ; i++) {
      const c = await b.evaluate(`window.__studio.blobChunk(${i})`);
      if (!c) break;
      chunks.push(Buffer.from(c, 'base64'));
    }
    const buf = Buffer.concat(chunks);
    const ext = done.mime === 'video/mp4' ? '.mp4' : '.webm';
    const file = out.endsWith(ext) ? out : out.replace(/\.(mp4|webm)$/i, '') + ext;
    fs.writeFileSync(file, buf);
    const log = await b.evaluate('JSON.stringify(window.__studio.log)').catch(() => '[]');
    console.log(JSON.stringify({ file, bytes: buf.length, mime: done.mime, seconds: shot.seconds, log: JSON.parse(log) }));
  } finally {
    await b.close();
  }
}

/**
 * Film: one PNG per frame on a stepped clock, the way the Reddit clips were
 * made, then GIF (15 fps) + WebP (30 fps) via scripts/studio-encode.py.
 *   node scripts/studio.mjs film <gameId> shot.json --out <dir> [--as handle] [--size 1920x1080] [--width 960]
 */
async function film() {
  const [gameId, shotFile] = rest;
  if (!gameId || !shotFile) die('film needs <gameId> shot.json --out <dir>');
  const dir = flag('out') || `orbital-${gameId}-frames`;
  const shot = JSON.parse(fs.readFileSync(shotFile, 'utf8'));
  const [w, h] = (flag('size') || (shot.format === '9:16' ? '1080x1920' : shot.format === '1:1' ? '1080x1080' : '1920x1080')).split('x').map(Number);
  const handle = flag('as') || 'studio-terra';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await openGame(gameId, handle, w, h);
  try {
    await warnShot(b, shot);
    const total = await b.evaluate(`window.__studio.openFilm(${JSON.stringify(shot)})`);
    // --trace: every hull's drawn position each frame, to trace.jsonl, for
    // scripts/jump-check.py (a hull should never jump).
    const tracing = argv.includes('--trace');
    const traceOut = tracing ? fs.openSync(path.join(dir, 'trace.jsonl'), 'w') : null;
    if (tracing) await b.evaluate('(window.__shipTrace = [], true)');
    console.error(`filming ${total} frames at ${w}x${h} as ${handle}…`);
    // The page renders at full size (layout and UI as players see them);
    // each frame is CAPTURED 960 wide as JPEG, since every clip ships 960
    // wide: at 1920 a quarter of the pixels to encode and pass over CDP,
    // about twice as fast a take. A UI clip renders the page smaller
    // (--size 1280x720) so its text is bigger in the 960 cut.
    // --full keeps lossless full-size PNGs.
    const fullCapture = argv.includes('--full');
    const capture = fullCapture
      ? { format: 'png', captureBeyondViewport: false }
      : { format: 'jpeg', quality: 92, captureBeyondViewport: false, clip: { x: 0, y: 0, width: w, height: h, scale: Math.min(1, 960 / w) } };
    const frames = [];
    const t0 = Date.now();
    for (let k = 0; k < total; k++) {
      // A frame waits on at most one server tick (bounded in the page at
      // 30 s + 90 s); past 600 s (a time cut can hold many ticks) the page is wedged and the take ends here
      // with what it has. A screenshot gets three tries.
      let done = false;
      try {
        const r = await b.evaluate(`window.__studio.filmFrame().then(r => JSON.stringify(r))`, 600_000);
        done = JSON.parse(r).done;
      } catch (e) {
        console.error(`\nframe ${k}: ${e.message}; ending the take with ${frames.length} frames`);
        break;
      }
      let shotPng = null;
      for (let attempt = 0; attempt < 3 && !shotPng; attempt++) {
        shotPng = await b.send('Page.captureScreenshot', capture, 30_000)
          .catch((e) => { console.error(`\nframe ${k}: screenshot try ${attempt + 1}: ${e.message}`); return null; });
      }
      if (!shotPng) { console.error(`\nframe ${k}: no screenshot; ending the take with ${frames.length} frames`); break; }
      const f = `${String(k).padStart(5, '0')}.${fullCapture ? 'png' : 'jpg'}`;
      fs.writeFileSync(path.join(dir, f), Buffer.from(shotPng.data, 'base64'));
      if (traceOut != null) {
        // The last frame the page drew for this film frame.
        const tr = await b.evaluate('JSON.stringify((window.__shipTrace || []).splice(0).pop() || null)', 10_000).catch(() => 'null');
        fs.writeSync(traceOut, JSON.stringify({ k, ...(JSON.parse(tr) || {}) }) + '\n');
      }
      frames.push({ f, t: k / (shot.fps ?? 30) });
      if (k % 30 === 0) {
        process.stderr.write(`\r  ${k}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
        // The manifest as it stands, so a killed take still encodes.
        fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));
      }
      if (done) break;
    }
    process.stderr.write('\n');
    if (traceOut != null) fs.closeSync(traceOut);
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));
    const stats = await b.evaluate('JSON.stringify(window.__studio.stats)', 10_000).catch(() => '{}');
    // The director's notes (picks, tick retries, missing targets), kept with the take.
    const log = await b.evaluate('JSON.stringify(window.__studio.log)', 10_000).catch(() => '[]');
    await b.evaluate('window.__studio.closeFilm()', 10_000).catch(() => {});
    console.log(JSON.stringify({ dir, frames: frames.length, seconds: shot.seconds, stats: JSON.parse(stats), log: JSON.parse(log) }));
    if (flag('encode') !== '0') {
      const width = flag('width') || '960';
      const enc = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'studio-encode.py');
      const name = flag('name') || path.basename(dir);
      console.error(`encoding ${name} at ${width}px…`);
      const encArgs = [enc, dir, '--name', name, '--width', width];
      if (flag('speed')) encArgs.push('--speed', flag('speed'));
      // An end card on the encode (studio-encode.py --end-title / --end-line).
      if (flag('end-title')) encArgs.push('--end-title', flag('end-title'), '--end-line', flag('end-line') || '');
      const r = spawn('python', encArgs, { stdio: 'inherit' });
      await new Promise(res => r.on('exit', res));
    }
  } finally {
    await b.close();
  }
}

/** Run JavaScript in the opened game: `await` works, window.__studio is there. */
async function evalInGame() {
  const [gameId, code] = rest;
  if (!gameId || !code) die('eval needs <gameId> "<javascript>"');
  // --size 1920x1080 checks the DOM at a film's size (the layout depends on it).
  const [w, h] = (flag('size') || '1080x1920').split('x').map(Number);
  const b = await openGame(gameId, flag('as') || 'studio-terra', w, h);
  try {
    const wrapped = `(async () => { return (${code}); })()`;
    const out = await b.evaluate(`(async () => { const r = (0, eval)(${JSON.stringify(wrapped)}); return JSON.stringify({ value: await r, log: window.__studio.log }); })()`);
    console.log(out);
  } finally { await b.close(); }
}

// ---------- main ----------

const COMMANDS = { catalog, apply, tick, record, film, close, eval: evalInGame };
(async () => {
  if (!cmd || !COMMANDS[cmd]) {
    console.error('usage: node scripts/studio.mjs catalog|apply|tick|record|eval|close … (docs/STUDIO.md)');
    process.exitCode = 2;
    return;
  }
  await COMMANDS[cmd]();
})().catch(e => {
  console.error(e instanceof Fail ? e.message : e);
  process.exitCode = 1;
});
