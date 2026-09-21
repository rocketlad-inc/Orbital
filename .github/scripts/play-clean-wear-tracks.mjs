// ============================================================
// Leave each Wear track holding exactly one live release.
//
// THE STATE THIS FIXES. Both wear tracks ended up carrying TWO releases
// for the same version code:
//
//   wear:internal
//     status=draft      versionCodes=[1016]  name=1.0
//     status=completed  versionCodes=[1016]  name=1.1.0
//
// The draft is left over from the console's own form-factor setup (the
// "Draft release: 1.0" the Internal testing page reports) and from the
// edit each API upload opens. A draft serves nobody by definition, but
// a draft holding the SAME version code as the completed release beside
// it is not a state Play's serving logic should have to reason about,
// and it is the only irregularity left in an otherwise correct setup:
// the bundle declares the watch feature, the tracks target every
// country, the listing has its Wear screenshots, and the tester has
// accepted the opt-in -- and the watch is still offered nothing.
//
// So: rewrite each wear track with only its completed release. Drafts
// are dropped, nothing is uploaded, no version code changes.
//
// Usage: PLAY_SA_JSON=<path> node play-clean-wear-tracks.mjs
//
// This COMMITS an edit -- it changes the app.
// ============================================================
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const sa = JSON.parse(readFileSync(process.env.PLAY_SA_JSON, 'utf8'));
const PKG = 'com.orbitalempire.game';
const b64url = (b) => Buffer.from(b).toString('base64url');

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: sa.token_uri, iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${signer.sign(sa.private_key, 'base64url')}`;
  const r = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

const auth = { authorization: `Bearer ${await token()}` };
const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;

const edit = await (await fetch(`${base}/edits`, { method: 'POST', headers: auth })).json();
if (!edit.id) throw new Error(`could not open an edit: ${JSON.stringify(edit)}`);

const tracks = await (await fetch(`${base}/edits/${edit.id}/tracks`, { headers: auth })).json();
if (!tracks.tracks) throw new Error(JSON.stringify(tracks));

let changed = 0;
for (const t of tracks.tracks) {
  if (!t.track.startsWith('wear:')) continue;
  const releases = t.releases ?? [];
  const live = releases.filter(r => r.status === 'completed');
  const drafts = releases.filter(r => r.status !== 'completed');
  if (drafts.length === 0 || live.length === 0) {
    console.log(`${t.track}: nothing to clean (${live.length} live, ${drafts.length} other)`);
    continue;
  }

  console.log(`${t.track}: dropping ${drafts.length} non-live release(s), keeping`
    + ` [${live.map(r => (r.versionCodes ?? []).join(',')).join('] [')}]`);

  const r = await fetch(`${base}/edits/${edit.id}/tracks/${encodeURIComponent(t.track)}`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ track: t.track, releases: live }),
  });
  if (!r.ok) throw new Error(`PUT ${t.track} failed: ${r.status} ${await r.text()}`);
  changed += 1;
}

if (changed === 0) {
  console.log('\nNothing to change; abandoning the edit rather than committing an empty one.');
  await fetch(`${base}/edits/${edit.id}`, { method: 'DELETE', headers: auth });
  process.exit(0);
}

const done = await (await fetch(`${base}/edits/${edit.id}:commit`, { method: 'POST', headers: auth })).json();
if (!done.id) throw new Error(`commit failed: ${JSON.stringify(done)}`);
console.log(`\ncommitted edit ${done.id}; ${changed} track(s) rewritten`);
