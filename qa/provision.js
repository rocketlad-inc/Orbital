// ============================================================
// QA harness — step 1: provision 4 throwaway test users + sessions.
//
// Explicitly authorized by Lorne (2026-07-20): "You have permission to
// make accounts and steer them." These are pure DB fixtures — no signup
// form, no real passwords (the stored hash is an all-zero dummy that can
// never verify, so the accounts are unusable by password login; the only
// way in is the session token this script emits, which lives in a local
// temp file). Cleanup: qa/cleanup.sql deletes everything by email domain.
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = Date.now();
const exp = now + 30 * 24 * 3600 * 1000;

// Dummy hash: valid pbkdf2 format so login code paths don't throw, but
// all-zero salt+digest means no password can ever match it.
const DUMMY_HASH = 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const NAMES = ['Aegis QA', 'Boreal QA', 'Cinder QA', 'Dusk QA'];
const users = NAMES.map((name, i) => ({
  id: b64url(crypto.randomBytes(12)),
  token: b64url(crypto.randomBytes(32)),
  email: `qa-p${i + 1}-${b64url(crypto.randomBytes(4)).toLowerCase()}@orbital-test.local`,
  name,
}));

let sql = '';
for (const u of users) {
  sql += `INSERT INTO users (id,email,display_name,password_hash,created_at,last_login_at) VALUES ('${u.id}','${u.email}','${u.name}','${DUMMY_HASH}',${now},${now});\n`;
  sql += `INSERT INTO sessions (token,user_id,created_at,expires_at,user_agent) VALUES ('${u.token}','${u.id}',${now},${exp},'qa-harness');\n`;
}

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'qa_users.json'), JSON.stringify(users, null, 2));
fs.writeFileSync(path.join(outDir, 'qa_provision.sql'), sql);
console.log('generated', users.length, 'users:');
for (const u of users) console.log(' ', u.name, u.id);
