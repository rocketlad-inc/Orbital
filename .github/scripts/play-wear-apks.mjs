// Download the Google-signed WATCH APKs Play serves, for one device shape.
//
//   PLAY_SA_JSON=<sa.json> node play-wear-apks.mjs <versionCode|latest> <outDir> [abi] [density]
//
// The watch counterpart of play-apks.mjs, which picks the PHONE variant
// and would pick nothing useful here. 'latest' means what the
// wear:internal track serves, not the highest bundle on the package.
//
// WHY: the Wear smoke ran our own debug build and passed, while a real
// watch would not launch the app. What a watch installs is not that
// build: Play regenerates it from the bundle, re-signs it, rewrites the
// Application class to com.pairip.application.Application and adds a
// license check (com.pairip.licensecheck.LicenseActivity). Only this
// artifact can answer "does the app Play serves start on a watch".
//
// Resolving 'latest' opens (and deletes) a Play edit, which kills any
// publish in flight -- do not run it during one.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createSign } from 'crypto';

const PKG = 'com.orbitalempire.game';
const sa = JSON.parse(readFileSync(process.env.PLAY_SA_JSON, 'utf8'));
const [WANT, OUT, ABI = 'x86', DENSITY = 'hdpi'] = process.argv.slice(2);
if (!WANT || !OUT) { console.error('usage: play-wear-apks.mjs <versionCode|latest> <outDir> [abi] [density]'); process.exit(2); }

const b64url = (b) => Buffer.from(b).toString('base64url');
async function token() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const c = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: sa.token_uri, iat: now, exp: now + 3600,
  }));
  const s = createSign('RSA-SHA256'); s.update(`${h}.${c}`);
  const r = await fetch(sa.token_uri, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${c}.${s.sign(sa.private_key, 'base64url')}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

const auth = { authorization: `Bearer ${await token()}` };
const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;

let VC = Number(WANT);
if (!VC) {
  const edit = await (await fetch(`${base}/edits`, { method: 'POST', headers: auth })).json();
  const t = await (await fetch(`${base}/edits/${edit.id}/tracks/${encodeURIComponent('wear:internal')}`, { headers: auth })).json();
  await fetch(`${base}/edits/${edit.id}`, { method: 'DELETE', headers: auth });
  const codes = (t.releases ?? []).filter(r => r.status === 'completed').flatMap(r => r.versionCodes ?? []).map(Number);
  if (!codes.length) { console.error('nothing completed on wear:internal'); process.exit(1); }
  VC = Math.max(...codes);
}
console.log(`watch versionCode: ${VC}`);

const list = await fetch(`${base}/generatedApks/${VC}`, { headers: auth });
const body = await list.json();
if (list.status !== 200) { console.error(JSON.stringify(body).slice(0, 800)); process.exit(1); }

mkdirSync(OUT, { recursive: true });
const wantSplits = new Set(['', `config.${ABI}`, `config.${DENSITY}`, 'config.en']);
let saved = 0;
for (const set of body.generatedApks ?? []) {
  console.log(`certificate sha256: ${set.certificateSha256Hash}`);
  const splits = set.generatedSplitApks ?? [];
  const variant = [...new Set(splits.map(a => a.variantId))]
    .find(v => splits.some(a => a.variantId === v && a.splitId === `config.${ABI}`));
  if (variant === undefined) { console.error(`no variant carries config.${ABI}`); process.exit(1); }
  for (const a of splits) {
    if (a.variantId !== variant || a.moduleName !== 'base' || !wantSplits.has(a.splitId ?? '')) continue;
    const r = await fetch(`${base}/generatedApks/${VC}/downloads/${a.downloadId}:download?alt=media`, { headers: auth });
    const buf = Buffer.from(await r.arrayBuffer());
    const name = `${a.splitId || 'base'}.apk`;
    writeFileSync(`${OUT}/${name}`, buf);
    console.log(`saved ${name} (${buf.length} bytes)`);
    saved++;
  }
}
if (!saved) { console.error('nothing saved'); process.exit(1); }
