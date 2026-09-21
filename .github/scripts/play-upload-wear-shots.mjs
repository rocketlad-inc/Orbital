// ============================================================
// Put the Wear OS screenshots on the store listing.
//
// WHY THIS IS THE THING THAT UNBLOCKS THE WATCH. A Wear release can sit
// on its track reading status=completed and still serve nobody, because
// Play will not distribute a watch app whose listing has no Wear OS
// screenshots. The console reports this as a track that is "Inactive"
// and a release that is "Unavailable on Google Play" -- two phrases on
// the release page, neither of which mentions the listing page where
// the actual problem is.
//
// IT REPLACES RATHER THAN APPENDS. deleteall first, then upload: an
// images.upload on its own adds, so running this twice would leave six
// screenshots, of which three are the ones from last time.
//
// Usage: PLAY_SA_JSON=<path> node play-upload-wear-shots.mjs <dir>
//
// Uploading is a COMMITTED edit -- unlike play-tracks.mjs, this one
// changes the app. A listing change goes through review, which for a
// screenshot is usually quick, and until it clears the watch app stays
// where it is.
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join } from 'node:path';

const sa = JSON.parse(readFileSync(process.env.PLAY_SA_JSON, 'utf8'));
const PKG = 'com.orbitalempire.game';
const DIR = process.argv[2];
if (!DIR) { console.error('usage: play-upload-wear-shots.mjs <dir>'); process.exit(2); }

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
const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;
const upload = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}`;

// Sorted, because the order they upload in is the order the store shows
// them, and "empire, situation, senate" is the order the app itself puts
// its pages in. The filenames carry the 1-/2-/3- prefix for exactly this.
const files = readdirSync(DIR).filter(f => f.endsWith('.png')).sort();
if (files.length === 0) throw new Error(`no PNGs in ${DIR}`);

const edit = await (await fetch(`${api}/edits`, { method: 'POST', headers: auth })).json();
if (!edit.id) throw new Error(`could not open an edit: ${JSON.stringify(edit)}`);

// Every language the listing has. A Wear screenshot set is per-language
// like any other image, and a listing that gains a second language later
// would otherwise silently go back to being unservable on watches.
const listings = await (await fetch(`${api}/edits/${edit.id}/listings`, { headers: auth })).json();
const langs = (listings.listings ?? []).map(l => l.language);
if (langs.length === 0) throw new Error('the app has no store listing to attach screenshots to');

for (const lang of langs) {
  const at = `${api}/edits/${edit.id}/listings/${lang}/wearScreenshots`;
  const del = await fetch(at, { method: 'DELETE', headers: auth });
  if (!del.ok && del.status !== 404) {
    throw new Error(`deleteall ${lang} failed: ${del.status} ${await del.text()}`);
  }
  for (const f of files) {
    const body = readFileSync(join(DIR, f));
    const r = await fetch(`${upload}/edits/${edit.id}/listings/${lang}/wearScreenshots?uploadType=media`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'image/png' },
      body,
    });
    if (!r.ok) throw new Error(`upload ${lang}/${f} failed: ${r.status} ${await r.text()}`);
    console.log(`uploaded ${lang}/${f}`);
  }
}

const committed = await (await fetch(`${api}/edits/${edit.id}:commit`, {
  method: 'POST', headers: auth,
})).json();
if (!committed.id) throw new Error(`commit failed: ${JSON.stringify(committed)}`);
console.log(`\ncommitted edit ${committed.id}`);
console.log('Wear screenshots are on the listing. Play reviews listing changes;');
console.log('the watch app becomes installable once that clears.');
