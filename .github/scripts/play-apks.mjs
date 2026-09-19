// ============================================================
// Download the APKs Play actually serves for a version code.
//
// These are generated from the AAB and signed with GOOGLE'S app signing
// key, not the upload key -- so they are the only artifact that matches
// what a store install puts on a phone. Everything CI builds itself is
// signed by us and is therefore a different app as far as Digital Asset
// Links and signature checks are concerned.
//
// Usage: PLAY_SA_JSON=<path> node play-apks.mjs <versionCode> <outDir>
//
// Fetches the base split plus the xxhdpi and en config splits of the
// split variant, which is the set an xxhdpi English device receives.
// Also prints certificateSha256Hash, which is the string assetlinks.json
// needs and which the console was never required to obtain.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createSign } from 'node:crypto';

const sa = JSON.parse(readFileSync(process.env.PLAY_SA_JSON, 'utf8'));
const PKG = 'com.orbitalempire.game';
const VC = Number(process.argv[2]);
const OUT = process.argv[3];
if (!VC || !OUT) { console.error('usage: play-apks.mjs <versionCode> <outDir>'); process.exit(2); }
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
const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;
const list = await fetch(`${base}/generatedApks/${VC}`, { headers: auth });
const body = await list.json();
if (list.status !== 200) { console.error(JSON.stringify(body).slice(0, 800)); process.exit(1); }

mkdirSync(OUT, { recursive: true });
let saved = 0;
for (const set of body.generatedApks ?? []) {
  console.log(`certificate sha256: ${set.certificateSha256Hash}`);
  const splits = set.generatedSplitApks ?? [];
  // The split variant with config splits is the one phones get. Take the
  // highest variantId that has a density split at all.
  const variants = [...new Set(splits.map(a => a.variantId))].sort((a, b) => b - a);
  const variant = variants.find(v => splits.some(a => a.variantId === v && /config\.xxhdpi$/.test(a.splitId ?? '')));
  if (variant === undefined) { console.error('no split variant with a density split'); process.exit(1); }
  const want = splits.filter(a => a.variantId === variant && a.moduleName === 'base'
    && ['', undefined, 'config.xxhdpi', 'config.en'].includes(a.splitId));
  for (const a of want) {
    const dl = await fetch(`${base}/generatedApks/${VC}/downloads/${a.downloadId}:download?alt=media`, { headers: auth });
    if (dl.status !== 200) { console.error(`download ${a.splitId || 'base'} -> ${dl.status}`); process.exit(1); }
    const buf = Buffer.from(await dl.arrayBuffer());
    const name = `${OUT}/${a.splitId ? a.splitId.replace('config.', 'split_config.') : 'base'}.apk`;
    writeFileSync(name, buf);
    console.log(`saved ${name} (${buf.length} bytes)`);
    saved++;
  }
}
if (saved < 2) { console.error('expected base plus at least one config split'); process.exit(1); }
