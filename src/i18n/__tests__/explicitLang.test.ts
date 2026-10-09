import { fmtNumber, fmtNumberIn, getLang, setLang, t, tIn, tk, tkIn, tn, tnIn } from '../core';

// tIn / tnIn / tkIn / fmtNumberIn are t / tn / tk / fmtNumber for a language
// that is NOT the one on screen: the event-log headlines are built twice per
// row (English for the classifiers and the audit log, the player's language
// for display).

afterEach(() => setLang('en', false));

describe('explicit-language lookups', () => {
  it('tIn answers in the asked language and leaves the current one alone', () => {
    expect(getLang()).toBe('en');
    expect(tIn('pt-BR', 'eventlog.ev.faction.revived', { name: 'Zed' }))
      .toBe('Zed fundou um novo assentamento e voltou à guerra');
    expect(tIn('en', 'eventlog.ev.faction.revived', { name: 'Zed' }))
      .toBe('Zed has founded a new settlement and is back in the war');
    expect(getLang()).toBe('en');
  });

  it('agrees with t() for the current language', () => {
    for (const lang of ['en', 'pt-BR'] as const) {
      setLang(lang, false);
      expect(tIn(lang, 'eventlog.ev.possessive', { owner: 'A', thing: 'B' }))
        .toBe(t('eventlog.ev.possessive', { owner: 'A', thing: 'B' }));
    }
  });

  it('tnIn uses the plural rules of the asked language (Portuguese counts 0 as one)', () => {
    expect(tnIn('pt-BR', 'eventlog.ev.game.started', 0)).toBe('O jogo começa — 0 facção');
    expect(tnIn('pt-BR', 'eventlog.ev.game.started', 1)).toBe('O jogo começa — 1 facção');
    expect(tnIn('pt-BR', 'eventlog.ev.game.started', 3)).toBe('O jogo começa — 3 facções');
    expect(tnIn('en', 'eventlog.ev.game.started', 0)).toBe('The game begins — 0 factions');
    expect(tnIn('en', 'eventlog.ev.game.started', 1)).toBe('The game begins — 1 faction');
    expect(tnIn('en', 'eventlog.ev.game.started', 2, { n: '2' })).toBe('The game begins — 2 factions');
    setLang('pt-BR', false);
    expect(tn('eventlog.ev.game.started', 3)).toBe(tnIn('pt-BR', 'eventlog.ev.game.started', 3));
  });

  it('tnIn fills {n} in the asked language and lets vars override it', () => {
    expect(tnIn('pt-BR', 'eventlog.ev.captain.kills', 1234)).toBe('1.234 abates.');
    expect(tnIn('en', 'eventlog.ev.captain.kills', 1234)).toBe('1,234 kills.');
    expect(tnIn('pt-BR', 'eventlog.ev.captain.kills', 1234, { n: '1234' })).toBe('1234 abates.');
  });

  it('tkIn falls back to the given English when the catalog has no entry', () => {
    expect(tkIn('pt-BR', 'data.ship.destroyer.name', 'destroyer')).toBe('Destróier');
    expect(tkIn('en', 'data.ship.destroyer.name', 'destroyer')).toBe('Destroyer');
    expect(tkIn('pt-BR', 'data.ship.nope.name', 'nope')).toBe('nope');
    setLang('pt-BR', false);
    expect(tk('data.ship.destroyer.name', 'destroyer')).toBe(tkIn('pt-BR', 'data.ship.destroyer.name', 'destroyer'));
  });

  it('fmtNumberIn formats for the asked language', () => {
    expect(fmtNumberIn('pt-BR', 1234.5)).toBe('1.234,5');
    expect(fmtNumberIn('en', 1234.5)).toBe('1,234.5');
    setLang('pt-BR', false);
    expect(fmtNumber(1234.5)).toBe(fmtNumberIn('pt-BR', 1234.5));
  });
});
