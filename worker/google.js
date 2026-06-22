// ============================================================
// Google ID token verification, Workers-native.
//
// Google's "Sign in with Google" returns a JWT (an "ID token") to the
// browser. The browser sends it to us; we verify it here:
//   1. Fetch Google's JWKS (public RSA keys, keyed by `kid`).
//   2. Find the key matching the JWT header's `kid`.
//   3. Verify the RS256 signature with Web Crypto's verify().
//   4. Validate the payload claims (issuer, audience, expiry).
//
// We never trust the payload until step 3 passes — anything else is a
// security hole.
//
// JWKS is cached in-memory per Worker instance with a short TTL. Cloudflare
// rotates Workers freely so this isn't a memory leak; the cache just dodges
// hitting Google on every sign-in burst.
// ============================================================

const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_CACHE_MS = 60 * 60 * 1000; // 1 hour

let jwksCache = null; // { keys: { [kid]: CryptoKey }, fetchedAt: number }

function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

async function loadJwks() {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();

  const imported = {};
  for (const k of keys) {
    if (k.kty !== 'RSA' || k.use !== 'sig' || k.alg !== 'RS256') continue;
    // CryptoKey for RSA-PKCS1-v1_5 verify, given the JWK directly.
    imported[k.kid] = await crypto.subtle.importKey(
      'jwk',
      k,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  }
  jwksCache = { keys: imported, fetchedAt: Date.now() };
  return imported;
}

/**
 * Verify a Google ID token. Returns the parsed payload on success.
 * Throws an Error with a stable code on failure — callers can match on
 * `e.code` to return a useful error to the client without leaking
 * verification details.
 */
export async function verifyGoogleIdToken(idToken, expectedAud) {
  if (typeof idToken !== 'string' || !idToken) {
    const e = new Error('missing token'); e.code = 'missing_token'; throw e;
  }
  if (!expectedAud) {
    const e = new Error('server missing GOOGLE_CLIENT_ID'); e.code = 'server_misconfigured'; throw e;
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    const e = new Error('malformed token'); e.code = 'malformed_token'; throw e;
  }
  const [hdrB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = b64urlToJson(hdrB64);
    payload = b64urlToJson(payloadB64);
  } catch {
    const e = new Error('malformed token'); e.code = 'malformed_token'; throw e;
  }

  if (header.alg !== 'RS256') {
    const e = new Error('unexpected alg'); e.code = 'bad_alg'; throw e;
  }

  const keys = await loadJwks();
  const key = keys[header.kid];
  if (!key) {
    const e = new Error('unknown signing key'); e.code = 'unknown_kid'; throw e;
  }

  // Signed input = `${header}.${payload}` (ASCII bytes), signature = sigB64
  const signedBytes = new TextEncoder().encode(`${hdrB64}.${payloadB64}`);
  const sigBytes = b64urlToBytes(sigB64);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    sigBytes,
    signedBytes,
  );
  if (!ok) {
    const e = new Error('signature failed'); e.code = 'bad_signature'; throw e;
  }

  // Signature checked — now validate claims.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    const e = new Error('token expired'); e.code = 'expired'; throw e;
  }
  // Google ID tokens carry `iat` (issued-at). Allow a small backdated skew.
  if (typeof payload.iat === 'number' && payload.iat > now + 60) {
    const e = new Error('token from the future'); e.code = 'iat_in_future'; throw e;
  }
  if (!GOOGLE_ISS.includes(payload.iss)) {
    const e = new Error('bad issuer'); e.code = 'bad_issuer'; throw e;
  }
  if (payload.aud !== expectedAud) {
    const e = new Error('audience mismatch'); e.code = 'bad_audience'; throw e;
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    const e = new Error('missing sub'); e.code = 'no_sub'; throw e;
  }
  if (typeof payload.email !== 'string') {
    const e = new Error('missing email'); e.code = 'no_email'; throw e;
  }
  // Google sets email_verified=true for accounts that have proved ownership.
  // We require it: an unverified email is a hijack risk.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    const e = new Error('email not verified'); e.code = 'email_unverified'; throw e;
  }

  return payload;
}
