// ============================================================
// Put the phone and tablet screenshots on the store listing.
//
// The sibling of play-upload-wear-shots.mjs, for the other three image
// slots. Each folder under play/ maps to one Play image type:
//
//   play/phone     -> phoneScreenshots      (8 max, 9:16 portrait)
//   play/tablet7   -> sevenInchScreenshots  (8 max)
//   play/tablet10  -> tenInchScreenshots    (8 max)
//
// Play's rules, checked here before anything uploads: 320..3840 px on
// each side, and the long side no more than TWICE the short one. The
// raw 412x915 phone captures are 2.2:1 and get refused, which is why the
// phone set is shot at 412x732 (exactly 9:16).
//
// IT REPLACES RATHER THAN APPENDS, same as the Wear script: deleteall per
// type, then upload in filename order (the 1-/2-/3- prefixes are the
// order the store shows). A folder that is missing leaves its slot alone.
//
// ONE EDIT FOR EVERYTHING, and it is committed: a listing change goes to
// review. Never run this while android.yml is publishing -- any edit
// opened mid-upload expires the publish's edit.
//
// Usage: PLAY_SA_JSON=<path> node play-upload-listing-shots.mjs [playDir]
// ============================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join } from 'node:path';

const sa = JSON.parse(readFileSync(process.env.PLAY_SA_JSON, 'utf8'));
const PKG = 'com.orbitalempire.game';
const ROOT = process.argv[2] ?? 'play';
const SLOTS = { phone: 'phoneScreenshots', tablet7: 'sevenInchScreenshots', tablet10: 'tenInchScreenshots' };

// PNG width/height live at bytes 16..24 of the IHDR chunk.
function pngSize(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const sets = [];
for (const [dir, type] of Object.entries(SLOTS)) {
  const at = join(ROOT, dir);
  if (!existsSync(at)) continue;
  const files = readdirSync(at).filter(f => f.endsWith('.png')).sort();
  if (files.length === 0) continue;
  if (files.length > 8) throw new Error(`${at}: ${files.length} images, Play allows 8`);
  for (const f of files) {
    const [w, h] = pngSize(readFileSync(join(at, f)));
    const lo = Math.min(w, h), hi = Math.max(w, h);
    if (lo < 320 || hi > 3840 || hi > 2 * lo) throw new Error(`${at}/${f} is ${w}x${h}: Play needs 320-3840px and at most 2:1`);
  }
  sets.push({ dir: at, type, files });
}
if (sets.length === 0) throw new Error(`nothing to upload under ${ROOT}/`);

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
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

const auth = { authorization: `Bearer ${await token()}` };
const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;
const upload = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}`;

const edit = await (await fetch(`${api}/edits`, { method: 'POST', headers: auth })).json();
if (!edit.id) throw new Error(`could not open an edit: ${JSON.stringify(edit)}`);

try {
  const listings = await (await fetch(`${api}/edits/${edit.id}/listings`, { headers: auth })).json();
  const langs = (listings.listings ?? []).map(l => l.language);
  if (langs.length === 0) throw new Error('the app has no store listing to attach screenshots to');

  for (const lang of langs) {
    for (const { dir, type, files } of sets) {
      const at = `${api}/edits/${edit.id}/listings/${lang}/${type}`;
      const del = await fetch(at, { method: 'DELETE', headers: auth });
      if (!del.ok && del.status !== 404) throw new Error(`deleteall ${lang}/${type}: ${del.status} ${await del.text()}`);
      for (const f of files) {
        const r = await fetch(`${upload}/edits/${edit.id}/listings/${lang}/${type}?uploadType=media`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'image/png' },
          body: readFileSync(join(dir, f)),
        });
        if (!r.ok) throw new Error(`upload ${lang}/${type}/${f}: ${r.status} ${await r.text()}`);
        console.log(`uploaded ${lang} ${type} ${f}`);
      }
    }
  }
} catch (e) {
  // Leave nothing half-done behind: an abandoned edit would also block
  // the next publish until it expired.
  await fetch(`${api}/edits/${edit.id}`, { method: 'DELETE', headers: auth });
  throw e;
}

const committed = await (await fetch(`${api}/edits/${edit.id}:commit`, { method: 'POST', headers: auth })).json();
if (!committed.id) throw new Error(`commit failed: ${JSON.stringify(committed)}`);
console.log(`\ncommitted edit ${committed.id}; the listing change is in Play review.`);
