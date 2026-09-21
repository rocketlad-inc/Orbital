// ============================================================
// What state is every Play track actually in?
//
// WHY THIS EXISTS. A release can sit on a track and serve nobody, and
// the console says so in two separate places that each look like
// decoration: a track reading "Inactive" and a release reading
// "Unavailable on Google Play". Neither names the field that is wrong,
// and the fix -- if there is one -- is behind a menu whose contents
// depend on that field. Reading the API takes ten seconds and replaces
// the whole guessing game.
//
// THE FIELD THAT MATTERS IS release.status:
//   draft       uploaded, serving nobody, and NOT rolling out. A draft
//               is finished by hand in the console or by a PATCH that
//               sets it to completed. This is what "Unavailable on
//               Google Play" means.
//   inProgress  a staged rollout; userFraction says to how many.
//   completed   live to everyone on the track.
//   halted      was rolling out, stopped.
//
// A track with no releases at all, or only drafts, reads "Inactive".
//
// IT ALSO PRINTS THE TRACK NAMES, which is the only trustworthy source
// for them. The published guidance names wear:qa; this app has no such
// track, and the upload that assumed otherwise failed at validation.
//
// Usage: PLAY_SA_JSON=<path> node play-tracks.mjs
//
// NOTE: resolving anything here costs a Play EDIT, and any edit opened
// against the app invalidates every other edit in flight. Do not run
// this while a publish is uploading -- see the retry in android.yml.
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

try {
  const tracks = await (await fetch(`${base}/edits/${edit.id}/tracks`, { headers: auth })).json();
  if (!tracks.tracks) throw new Error(JSON.stringify(tracks));

  console.log(`\nTRACKS for ${PKG}\n${'='.repeat(60)}`);
  for (const t of tracks.tracks) {
    const releases = t.releases ?? [];
    console.log(`\n${t.track}`);
    if (releases.length === 0) {
      console.log('  (no releases)');
      continue;
    }
    for (const r of releases) {
      const codes = (r.versionCodes ?? []).join(', ') || '—';
      const frac = r.userFraction != null ? `  userFraction=${r.userFraction}` : '';
      console.log(`  status=${r.status}  versionCodes=[${codes}]  name=${r.name ?? '—'}${frac}`);
      if (r.status === 'draft') {
        console.log('     ^ DRAFT: uploaded, serving nobody, not rolling out.');
      }
      // WHERE it is served, which is a separate way to be invisible. A
      // release can be completed, on the right track, with a tester who
      // has accepted the invitation, and still not appear -- because the
      // track targets a country that tester is not in. The console
      // renders this as a quiet "1 country / region" beside the track
      // name and never says which.
      const ct = r.countryTargeting;
      if (ct) {
        const list = (ct.countries ?? []).join(', ') || '(none)';
        console.log(`     countries: ${list}${ct.includeRestOfWorld ? ' + rest of world' : ''}`);
      } else {
        console.log('     countries: all');
      }
    }
  }

  // ---- the app-level gate -------------------------------------------
  //
  // A release can be 'completed' on its track and still serve nobody,
  // which is the state the console calls "Unavailable on Google Play"
  // while naming nothing. For a Wear OS form factor the usual cause is
  // the STORE LISTING rather than the release: Play will not serve a
  // watch app until the listing carries Wear OS screenshots, and that
  // requirement lives on a different page from the release entirely.
  //
  // So count the images per language. wearScreenshots at zero is the
  // answer; anything else and the blocker is elsewhere.
  const IMAGE_TYPES = [
    'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots',
    'tvScreenshots', 'wearScreenshots', 'icon', 'featureGraphic', 'tvBanner',
  ];
  const listings = await (await fetch(`${base}/edits/${edit.id}/listings`, { headers: auth })).json();
  const langs = (listings.listings ?? []).map(l => l.language);
  console.log('');
  console.log('='.repeat(60));
  console.log(`STORE LISTING (${langs.join(', ') || 'no listings'})`);
  for (const lang of langs) {
    console.log('');
    console.log(`  ${lang}`);
    for (const type of IMAGE_TYPES) {
      const r = await fetch(`${base}/edits/${edit.id}/listings/${lang}/${type}`, { headers: auth });
      const j = await r.json();
      const n = (j.images ?? []).length;
      const flag = type === 'wearScreenshots' && n === 0
        ? '   <== MISSING. Play will not serve a watch app without these.'
        : '';
      console.log(`    ${type.padEnd(22)} ${n}${flag}`);
    }
  }
  console.log('');

} finally {
  // Never commit: this is a read-only look, and a committed empty edit
  // would count as a change to the app.
  await fetch(`${base}/edits/${edit.id}`, { method: 'DELETE', headers: auth });
}
