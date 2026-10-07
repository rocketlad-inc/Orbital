// Saving the language choice on the account, so it follows the player
// from this browser to the phone app and to the next device.

import { apiFetch } from '../multiplayer/api';
import type { Lang } from './core';

/** Fire and forget: a failed save must never get in the way of the
 *  switch itself, which already took effect in this browser. */
export function saveLocale(lang: Lang | null): void {
  void apiFetch('/api/users/me/locale', { method: 'PUT', body: JSON.stringify({ locale: lang }) });
}
