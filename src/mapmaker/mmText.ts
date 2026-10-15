// The Map Maker's words in the player's language.
//
// The data tables the maker shares with the server (src/game/customMap.js)
// and its own tables (ops.ts PRESETS, MOODS...) keep their English, which
// the code compares and saves. These helpers turn an id into a label at
// RENDER time, so a language switch after import still takes effect.
//
// The checklist (checkMap) is built in English because the server runs it
// too; issueText rebuilds each line from its stable `code` and `params`.

import { getLang, t, tk, tn, type Key, type PluralKey } from '../i18n/core';
import { SECRET_DEFS } from '../game/secrets';
import { TYPE_INFO, type MapBodyType, type MapIssue } from '../game/customMap';

const k = (key: string) => key as Key;

/** "Planet", "Gas giant"... (a belt is not a type, but the palette has one). */
export function typeLabel(type: MapBodyType | 'belt'): string {
  return tk(`mm.type.${type}`, type === 'belt' ? 'Asteroid belt' : TYPE_INFO[type].label);
}
export const surfaceLabel = (s: string) => tk(`mm.surface.${s}`, s);
export const backdropLabel = (bd: string) => tk(`mm.backdrop.${bd}`, bd);
export const themeLabel = (theme: string) => tk(`mm.theme.${theme}`, theme);
export const presetLabel = (label: string) => tk(`mm.preset.${label}`, label);
export const moodLabel = (m: { id: string; label: string }) => tk(`mm.mood.${m.id}.label`, m.label);
export const moodBlurb = (m: { id: string; blurb: string }) => tk(`mm.mood.${m.id}.blurb`, m.blurb);
export const starLabel = (color: string, english: string) => tk(`mm.star.${color}`, english);

/** A discovery's name, as the game itself names it. */
export function secretName(kind: string): string {
  if (kind === 'random') return t('mm.secret.random');
  return (SECRET_DEFS as Record<string, { displayName: string }>)[kind]?.displayName ?? kind.replace(/_/g, ' ');
}
export const secretHint = (kind: string) => tk(`mm.secretHint.${kind}`, '');

/** "A, B and C". */
export function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return t('mm.list.last', { a: xs.slice(0, -1).join(', '), b: xs[xs.length - 1] });
}

/** The tap/click flavour of a hint. */
export const touchKey = (base: string, touch: boolean) => k(`${base}.${touch ? 'touch' : 'mouse'}`);

/** A checklist line in the player's language. English readers get the
 *  checker's own words (the same the server sends); a code this client
 *  does not know yet keeps them too. */
export function issueText(i: MapIssue): { title: string; detail: string } {
  if (getLang() === 'en') return { title: i.title, detail: i.detail };
  const out = translateIssue(i);
  return out ?? { title: i.title, detail: i.detail };
}

/** Just the title, for the "Fix the blockers first: ..." lists. */
export const issueTitle = (i: MapIssue) => issueText(i).title;

function translateIssue(i: MapIssue): { title: string; detail: string } | null {
  const p = i.params;
  if (!p) return null;
  const n = p.count ?? 0;
  const pl = (key: string, count: number, vars?: Record<string, string | number>) => tn(key as PluralKey, count, vars);
  switch (i.code) {
    case 'too_few_starts':
      return { title: t('mm.issue.starts.title', { n }), detail: t(p.marked ? 'mm.issue.tooFew.marked' : 'mm.issue.tooFew.auto') };
    case 'starts':
      return { title: t('mm.issue.starts.title', { n }), detail: t(p.marked ? 'mm.issue.starts.marked' : 'mm.issue.starts.auto', { seats: p.seats ?? 0 }) };
    case 'start_no_science':
      return { title: pl('mm.issue.noScience.title', n), detail: t('mm.issue.noScience.detail') };
    case 'starts_close':
      return {
        title: t('mm.issue.close.title'),
        detail: t('mm.issue.close.detail', { list: (p.groups ?? []).map(listJoin).join('; ') }),
      };
    case 'orbits_close':
      return {
        title: pl('mm.issue.orbits.title', n),
        detail: t('mm.issue.orbits.detail', { list: (p.pairs ?? []).map(listJoin).join('; ') + (p.more ? '…' : '') }),
      };
    case 'moon_far':
      return { title: t('mm.issue.moonFar.title'), detail: pl('mm.issue.moonFar.detail', n, { names: (p.names ?? []).join(', ') }) };
    case 'names_dup':
      return { title: pl('mm.issue.namesDup.title', n), detail: t('mm.issue.namesDup.detail') };
    case 'names':
      return { title: t('mm.issue.names.title'), detail: t('mm.issue.names.detail') };
    case 'no_resources':
      return { title: t('mm.issue.noRes.title'), detail: t('mm.issue.noRes.detail') };
    case 'none_metal':
    case 'none_credits':
    case 'none_science':
      return { title: t(k(`mm.issue.${i.code}.title`)), detail: t(k(`mm.issue.${i.code}.detail`)) };
    case 'resources':
      return {
        title: t('mm.issue.res.title'),
        detail: t('mm.issue.res.detail', { metal: p.metal ?? 0, credits: p.credits ?? 0, science: p.science ?? 0 }),
      };
    case 'sector_empty':
      return { title: pl('mm.issue.sectorEmpty.title', n), detail: pl('mm.issue.sectorEmpty.detail', n, { names: (p.names ?? []).join(', ') }) };
    case 'sector_loose':
      return { title: pl('mm.issue.sectorLoose.title', n), detail: t('mm.issue.sectorLoose.detail') };
    case 'sector_starts':
      return {
        title: t('mm.issue.sectorStarts.title', { n, sector: p.sector ?? '' }),
        detail: t('mm.issue.sectorStarts.detail', { names: listJoin(p.names ?? []), sector: p.sector ?? '' }),
      };
    case 'sector_names':
      return { title: t('mm.issue.sectorNames.title'), detail: t('mm.issue.sectorNames.detail') };
    case 'sectors':
      return {
        title: pl('mm.issue.sectors.title', n),
        detail: t('mm.issue.sectors.detail', { list: (p.list ?? []).map(([name, w]) => `${name} (${w})`).join(' · ') }),
      };
    case 'secrets':
      return {
        title: t('mm.issue.secrets.title'),
        detail: (p.placed ?? 0) + (p.chance ?? 0)
          ? t('mm.issue.secrets.some', { placed: p.placed ?? 0, chance: p.chance ?? 0 })
          : t('mm.issue.secrets.none'),
      };
    case 'max_bodies':
      return { title: t('mm.issue.maxBodies.title', { n: p.max ?? 0 }), detail: t('mm.issue.maxBodies.detail') };
    default:
      return null;
  }
}

/** A Map Maker server error in the player's language. The worker answers
 *  in English: an English reader sees its words; anyone else sees the
 *  known codes translated, or the screen's own fallback. */
export function mapApiError(error: { code: string; message: string; blockers?: MapIssue[] } | null | undefined, fallback: Key): string {
  if (!error) return t(fallback);
  if (getLang() === 'en') return error.message || t(fallback);
  const msg = error.message ?? '';
  switch (error.code) {
    case 'unauthenticated': return t('err.unauthenticated');
    case 'network_error': return t('err.network');
    case 'too_large': return t('mm.err.tooLarge');
    case 'too_many_maps': return t('mm.err.tooMany');
    case 'bad_code': return t('mm.err.badCode');
    case 'name_required': return t('mm.err.nameRequired');
    case 'commission_required': return t('mm.err.commission', { name: t('hangar.commissionName') });
    case 'map_blocked':
      return error.blockers?.length
        ? t('mm.err.blocked', { list: error.blockers.map(issueTitle).join('; ') })
        : t('mm.err.blockedPublish');
    case 'not_found':
      return /code/i.test(msg) ? t('mm.err.noCode') : t(fallback);
    case 'bad_request':
      if (/at least 4/i.test(msg)) return t('mm.err.pwShort');
      if (/password too long/i.test(msg)) return t('err.pw_long');
      return t(fallback);
    default:
      return t(fallback);
  }
}
