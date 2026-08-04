// ============================================================================
// botSettings.js — runtime knobs for the Discord bot.
//
// These were constants. They shouldn't be: their correct values are
// discovered by watching players react, not by reasoning at a keyboard.
// "6pm, not noon" is a preference, and a preference that needs a deploy
// to change is a preference nobody adjusts.
//
// Defaults live here so a missing row behaves exactly like the value the
// code shipped with — the table only ever OVERRIDES.
// ============================================================================

export const DEFAULTS = {
  /** Hour (0-23, US Eastern) the personal situation report DMs go out. */
  sitrep_hour_eastern: 18,
  /** Send a report even when nothing needs the player? A briefing that
   *  says "nothing happened" is how people learn to ignore briefings. */
  sitrep_send_when_quiet: true,
  /** Hour (0-23, US Eastern) the Herald posts to the channel. */
  herald_hour_eastern: 12,
  /** Master switches — flip a whole feature off without a deploy. */
  sitrep_enabled: true,
  herald_enabled: true,
  senate_cards_enabled: true,
  /** Post a poster to the channel when a real battle resolves. */
  battle_cards_enabled: true,
  dm_relay_enabled: true,
};

/** All settings, defaults merged with any stored overrides. */
export async function getSettings(env) {
  const out = { ...DEFAULTS };
  try {
    const rows = (await env.DB.prepare('SELECT key, value FROM bot_settings').all()).results ?? [];
    for (const r of rows) {
      if (!(r.key in DEFAULTS)) continue;      // ignore stale/unknown keys
      try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
    }
  } catch { /* table missing / D1 hiccup — defaults are always safe */ }
  return out;
}

export async function getSetting(env, key) {
  const all = await getSettings(env);
  return all[key];
}

export async function setSetting(env, key, value, userId = null) {
  if (!(key in DEFAULTS)) return { ok: false, reason: 'unknown_key' };
  // Type-check against the default so a bad write can't, say, make an
  // hour into a string and silently disable a schedule.
  const want = typeof DEFAULTS[key];
  if (typeof value !== want) return { ok: false, reason: `expected_${want}` };
  if (key.endsWith('_hour_eastern') && (value < 0 || value > 23)) {
    return { ok: false, reason: 'hour_out_of_range' };
  }
  await env.DB
    .prepare(
      `INSERT INTO bot_settings (key, value, updated_ms, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_ms = excluded.updated_ms, updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(value), Date.now(), userId)
    .run();
  return { ok: true };
}

/** True during the given hour in US Eastern, DST-correct. */
export function isEasternHour(nowMs, hour) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date(nowMs));
  return (Number(h) % 24) === hour;
}
