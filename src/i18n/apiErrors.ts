// ============================================================
// Server errors, in the player's language.
//
// The worker answers { error: { code, message } } with an ENGLISH
// message. Showing that message to a Portuguese player defeats the
// translation, so screens ask this helper instead: it maps the stable
// `code` (and, for the few codes that carry several meanings like
// bad_request, the exact validation message) to a catalog key, and only
// falls back to the screen's own localized default when nothing matches.
//
// A code or message the server learns later still shows the server's
// English text rather than nothing, but only in English: in any other
// language the caller's localized fallback is used, so the screen never
// mixes two languages.
// ============================================================

import { getLang, t, type Key } from './core';

export type ApiError = { code: string; message: string } | null | undefined;

// Exact messages worker/index.js uses for validation failures that all
// share code 'bad_request'. Matched first: they are more specific.
const BY_MESSAGE: Array<[RegExp, Key]> = [
  [/^invalid email$/i, 'err.bad_email'],
  [/password must be at least 8/i, 'err.pw_short'],
  [/^password too long$/i, 'err.pw_long'],
  [/^invalid display_name$/i, 'err.bad_name'],
  [/email and password required/i, 'err.need_credentials'],
  [/no room with that code/i, 'err.no_code'],
];

const BY_CODE: Record<string, Key> = {
  unauthenticated: 'err.unauthenticated',
  invalid_credentials: 'err.invalid_credentials',
  email_taken: 'err.email_taken',
  room_full: 'err.room_full',
  room_closed: 'err.room_closed',
  not_found: 'err.not_found',
  not_member: 'err.not_member',
  not_host: 'err.not_host',
  password_required: 'err.password_required',
  bad_password: 'err.bad_password',
  already_started: 'err.already_started',
  too_few_players: 'err.too_few_players',
  invalid_token: 'err.invalid_token',
  raise_only: 'err.raise_only',
};

/** The message to show for an API error. `fallback` is the localized
 *  default for the screen's action ("Could not join that game."). */
export function apiErrorText(error: ApiError, fallback: Key): string {
  if (error) {
    for (const [re, key] of BY_MESSAGE) if (re.test(error.message ?? '')) return t(key);
    const key = BY_CODE[error.code];
    if (key) return t(key);
    // Unknown to us: the server's English is better than nothing, but
    // only for an English reader.
    if (error.message && getLang() === 'en') return error.message;
  }
  return t(fallback);
}
