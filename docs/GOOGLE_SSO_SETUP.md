# Google Sign-In setup

The frontend renders a "Sign in with Google" button **only when the
backend advertises a `GOOGLE_CLIENT_ID`**. If the variable isn't set, the
button is hidden and the email/password form is the only option — so the
production site can ship safely before this is configured.

## 1. Create a Google Cloud OAuth client

Do this in your Google Cloud Console; nothing about it lives in code.

1. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `Orbital` (or whatever you'd like users to see on the consent screen)
   - User support email + developer contact: your address
   - Scopes: leave at the default (`openid`, `email`, `profile`)
   - You can leave it in **Testing** mode while you're rolling out — Google
     allows up to 100 test users without verification.

2. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Orbital Web` (internal label, never shown to users)
   - **Authorized JavaScript origins** — add every origin the site is served from:
     - `https://orbital.<your-domain>` (prod)
     - `http://localhost:3000` (CRA dev server)
     - `http://localhost:8787` (wrangler dev, if you use it)
   - **Authorized redirect URIs**: leave empty. We use Google Identity
     Services in *implicit ID-token* mode — the JWT comes back via the
     JS callback, no redirect.

3. Copy the **Client ID** (looks like `1234567890-abc...apps.googleusercontent.com`).
   You'll paste it into the next step.

## 2. Wire it into the Worker

The Client ID is a value the browser already sees — it's safe to commit,
but a Wrangler secret is the easiest way to keep dev and prod separated:

```sh
# Prod
wrangler secret put GOOGLE_CLIENT_ID
#   <paste the client id>

# Local dev — wrangler reads `.dev.vars`
echo 'GOOGLE_CLIENT_ID="1234567890-abc...apps.googleusercontent.com"' >> .dev.vars
```

Restart the worker and verify the config endpoint:

```sh
curl https://orbital.<your-domain>/api/auth/config
# → {"google_client_id":"1234...apps.googleusercontent.com"}
```

If it returns `{"google_client_id":null}`, the secret didn't make it
into the running deployment — re-run `wrangler secret put` then redeploy.

## 3. (Already done) Apply the DB migration

`migrations/0027_google_oauth.sql` adds:
- `users.google_sub TEXT` + a `UNIQUE INDEX` on it — the canonical Google account ID
- (additive only — `password_hash` stays `NOT NULL`; Google-only accounts get
  `password_hash = ''`, which `verifyPassword` rejects, so they can't be logged
  into via the password form. This avoids a destructive `users` table rebuild on
  a live database — see the migration's header comment.)

The worker auto-applies pending migrations on the first `/api/*` request.
If you prefer to apply manually:

```sh
wrangler d1 migrations apply orbital
```

## 4. Test

1. Visit `/` — you should see the **Sign in with Google** button above the
   email field.
2. Click it. The Google consent popup opens.
3. After picking an account you're returned to the app, signed in.
4. Sanity-check the database row:
   ```sh
   wrangler d1 execute orbital --command "SELECT id, email, display_name, google_sub IS NOT NULL AS via_google FROM users WHERE email = 'your@email.com'"
   ```

## What happens server-side

`POST /api/auth/google` receives `{ id_token }` and:

1. Verifies the JWT against Google's JWKS (`oauth2/v3/certs`), checking
   the RS256 signature with Web Crypto.
2. Validates `iss`, `aud === GOOGLE_CLIENT_ID`, `exp`, `email_verified`.
3. Three branches in upsert order:
   - **Returning Google user** (matches `google_sub`): just touches `last_login_at`.
   - **Existing email account** (matches `email`): links the Google ID onto
     the existing row so future Google sign-ins find it via `google_sub`.
   - **New user**: provisions a row with `password_hash = ''` and `google_sub`.
4. Issues an `orbital_session` cookie exactly like password login.

## Linking & unlinking

- A user who originally signed up with password + email can sign in via
  Google for the first time: the backend matches them on email and attaches
  `google_sub` automatically.
- A user who originally signed in via Google has `password_hash = ''`.
  They cannot use the email/password form until they add a password — there
  is no UI for that yet (file: `docs/GOOGLE_SSO_SETUP.md` → todo).
- There is no "unlink Google" UI yet either; for now, run SQL directly:
  ```sh
  wrangler d1 execute orbital --command "UPDATE users SET google_sub = NULL WHERE email = 'x@y.com'"
  ```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No Google button visible on `/` | `GOOGLE_CLIENT_ID` not set — check `/api/auth/config` |
| Button renders, click → "popup blocked" | Browser blocked the popup. The GIS button uses Google's own iframe so this is rare; re-clicking usually works |
| Sign-in works in dev but fails in prod | Prod origin not in **Authorized JavaScript origins** in Google Cloud Console |
| `bad_audience` in the response | The Client ID the browser used doesn't match `env.GOOGLE_CLIENT_ID` — you have two different client IDs floating around |
| `email_unverified` | The Google account hasn't confirmed its email. We require verified emails to prevent hijack via unverified Google sign-ups |
| Migration didn't apply | Hit `POST /api/__init` once — it applies any pending migrations |
