import { catalogs, LANGS, setLang, t, tn, relativeTime, fmtNumber } from '../core';
import { en, enBase } from '../en';
import * as enParts from '../parts/en';
import * as ptParts from '../parts/pt-BR';
import { apiErrorText } from '../apiErrors';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const baseOf = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '');

describe('translation catalogs', () => {
  const all = catalogs();

  for (const { code } of LANGS) {
    if (code === 'en') continue;
    const cat = all[code] as Record<string, string>;

    it(`${code}: every key exists in English`, () => {
      const orphans = Object.keys(cat).filter(k => !(k in en));
      expect(orphans).toEqual([]);
    });

    it(`${code}: {placeholders} match English, key for key`, () => {
      const bad = Object.keys(cat)
        .filter(k => k in en && placeholders(cat[k]) !== placeholders((en as Record<string, string>)[k]));
      expect(bad).toEqual([]);
    });

    it(`${code}: plural keys have both forms`, () => {
      const bases = new Set(Object.keys(cat).filter(k => /_(one|other)$/.test(k)).map(baseOf));
      const missing = [...bases].filter(b => !(`${b}_one` in cat && `${b}_other` in cat));
      expect(missing).toEqual([]);
    });

    it(`${code}: nothing is left untranslated by accident`, () => {
      // Same text as English is fine for names and numbers, but a long
      // sentence identical to the source is a copy-paste that was never
      // translated.
      const same = Object.keys(cat).filter(k => cat[k] === (en as Record<string, string>)[k] && cat[k].length > 28);
      expect(same).toEqual([]);
    });
  }

  it('English plural keys come in pairs', () => {
    const keys = Object.keys(en);
    const bases = new Set(keys.filter(k => /_(one|other)$/.test(k)).map(baseOf));
    const missing = [...bases].filter(b => !(`${b}_one` in en && `${b}_other` in en));
    expect(missing).toEqual([]);
  });
});

describe('catalog parts', () => {
  const prefixes = enParts.PART_PREFIXES;
  const partNames = Object.keys(prefixes);
  const own = (part: Record<string, unknown>) => Object.keys(part);

  it('every part is wired into the English catalog and keeps to its own key prefixes', () => {
    const outside: string[] = [];
    for (const name of partNames) {
      const part = (enParts as unknown as Record<string, Record<string, string>>)[name];
      for (const k of own(part)) {
        if (!prefixes[name].some(p => k.startsWith(p))) outside.push(`${name}: ${k}`);
        if (!(k in en)) outside.push(`${name}: ${k} (not in the assembled catalog)`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('no part reuses a base key or another part key', () => {
    const seen = new Map<string, string>(Object.keys(enBase).map(k => [k, 'base']));
    const dupes: string[] = [];
    for (const name of partNames) {
      const part = (enParts as unknown as Record<string, Record<string, string>>)[name];
      for (const k of own(part)) {
        if (seen.has(k)) dupes.push(`${k} (${name} and ${seen.get(k)})`);
        seen.set(k, name);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('a Portuguese part only translates keys its English part owns', () => {
    const stray: string[] = [];
    for (const name of partNames) {
      const pt = (ptParts as unknown as Record<string, Record<string, string>>)[name];
      const e = (enParts as unknown as Record<string, Record<string, string>>)[name];
      for (const k of own(pt)) if (!(k in e)) stray.push(`${name}: ${k}`);
    }
    expect(stray).toEqual([]);
  });
});

describe('lookup', () => {
  afterEach(() => setLang('en', false));

  it('translates, fills placeholders and falls back to English', () => {
    setLang('pt-BR', false);
    expect(t('lobby.nav.browse')).toBe('Explorar');
    expect(t('lobby.hero.welcome', { name: 'Ana' })).toBe('Bem-vindo de volta, Ana');
    setLang('en', false);
    expect(t('lobby.hero.welcome', { name: 'Ana' })).toBe('Welcome back, Ana');
  });

  it('plurals follow the language (Portuguese counts 0 as singular)', () => {
    setLang('pt-BR', false);
    expect(tn('card.worlds', 0)).toBe('0 mundo');
    expect(tn('card.worlds', 1)).toBe('1 mundo');
    expect(tn('card.worlds', 2)).toBe('2 mundos');
    setLang('en', false);
    expect(tn('card.worlds', 0)).toBe('0 worlds');
    expect(tn('card.worlds', 1)).toBe('1 world');
  });

  it('numbers and relative times use the language', () => {
    setLang('pt-BR', false);
    expect(fmtNumber(7.5)).toBe('7,5');
    expect(relativeTime(-86_400_000)).toMatch(/ontem/i);
    setLang('en', false);
    expect(fmtNumber(7.5)).toBe('7.5');
    expect(relativeTime(-86_400_000)).toMatch(/yesterday/i);
  });

  it('API errors are translated by code and by validation message', () => {
    setLang('pt-BR', false);
    expect(apiErrorText({ code: 'room_full', message: 'room is full' }, 'err.generic')).toBe('Esse jogo está cheio.');
    expect(apiErrorText({ code: 'bad_request', message: 'password must be at least 8 characters' }, 'err.generic'))
      .toBe('A senha precisa ter pelo menos 8 caracteres.');
    // An unknown server message is NOT shown in English to a Portuguese reader.
    expect(apiErrorText({ code: 'something_new', message: 'a brand new english message' }, 'err.generic'))
      .toBe('Algo deu errado. Tente de novo em instantes.');
    setLang('en', false);
    expect(apiErrorText({ code: 'something_new', message: 'a brand new english message' }, 'err.generic'))
      .toBe('a brand new english message');
  });
});
