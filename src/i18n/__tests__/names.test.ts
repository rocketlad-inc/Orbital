// Stored names shown in the player's language (playtest 2026-10-24, D1/D8):
// real Sol worlds and the template words the server builds names from
// translate; generated proper names never do.
import { bodyNameIn, settlementNameIn, shipNameIn, designNameIn, ofPlace } from '../names';
import { pluralRule, setLang, tn } from '../core';
import { inLang } from '../serverText';
import { systemLabel, serverSystemLabel } from '../../game/systemGrouping';
import type { Body } from '../../types';

afterEach(() => setLang('en', false));

describe('world names', () => {
  it('uses the Portuguese names of the real Sol bodies', () => {
    const pt = (n: string) => bodyNameIn('pt-BR', n);
    expect(['Earth', 'Luna', 'Mars', 'Jupiter', 'Ganymede', 'Callisto', 'Uranus', 'Neptune', 'Pluto', 'Triton', 'Titania'].map(pt))
      .toEqual(['Terra', 'Lua', 'Marte', 'Júpiter', 'Ganimedes', 'Calisto', 'Urano', 'Netuno', 'Plutão', 'Tritão', 'Titânia']);
    expect(pt('Europa')).toBe('Europa');
    expect(pt('Verdant')).toBe('Verdant');           // an invented far world keeps its name
    expect(pt('Mars Gate')).toBe('Portal de Marte');
    expect(pt('Earth Gate')).toBe('Portal da Terra');
    expect(bodyNameIn('en', 'Earth')).toBe('Earth');
  });

  it('heads a planet system "SISTEMA DE URANO", not "SISTEMA URANUS"', () => {
    const bodies = [
      { id: 'sol', name: 'Sol', type: 'star' },
      { id: 'uranus', name: 'Urano', type: 'ice_giant', parent: 'sol' },
      { id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus' },
      { id: 'earth', name: 'Terra', type: 'terrestrial', parent: 'sol' },
      { id: 'luna', name: 'Lua', type: 'moon', parent: 'earth' },
    ] as unknown as Body[];
    setLang('pt-BR', false);
    expect(systemLabel(bodies, 'uranus').toUpperCase()).toBe('SISTEMA DE URANO');
    expect(systemLabel(bodies, 'earth')).toBe('Sistema da Terra');
    setLang('en', false);
    expect(systemLabel(bodies, 'uranus')).toBe('Urano System');
    expect(ofPlace('en', 'Mars')).toBe('Mars');
  });

  it('translates the system labels the server builds (Senate vote weight)', () => {
    setLang('pt-BR', false);
    expect(serverSystemLabel('Saturn System')).toBe('Sistema de Saturno');
    expect(serverSystemLabel('Earth System')).toBe('Sistema da Terra');
    expect(serverSystemLabel('Kuiper Belt')).toBe('Cinturão de Kuiper');
    expect(serverSystemLabel('The Core')).toBe('O Núcleo');
    expect(serverSystemLabel('Ceres')).toBe('Ceres');
    expect(serverSystemLabel('Pluto')).toBe('Plutão');
    setLang('en', false);
    expect(serverSystemLabel('Saturn System')).toBe('Saturn System');
  });
});

describe('generated names: only the template words translate', () => {
  it('settlements', () => {
    expect(settlementNameIn('pt-BR', 'Station')).toBe('Estação');
    expect(settlementNameIn('pt-BR', 'New City')).toBe('Nova Cidade');
    expect(settlementNameIn('pt-BR', 'Solar Directorate Capital')).toBe('Capital de Solar Directorate');
    expect(settlementNameIn('pt-BR', 'Mars Station 2')).toBe('Estação de Marte 2');
    expect(settlementNameIn('pt-BR', 'Mos Eisley')).toBe('Mos Eisley');
    expect(settlementNameIn('en', 'Solar Directorate Capital')).toBe('Solar Directorate Capital');
  });

  it('ships and designs', () => {
    expect(shipNameIn('pt-BR', 'Vanguard of Earth')).toBe('Vanguard da Terra');
    expect(shipNameIn('pt-BR', 'Pioneer of Mars')).toBe('Pioneer de Marte');
    expect(shipNameIn('pt-BR', 'Kestrel')).toBe('Kestrel');
    // The trial's head-start hulls (worker/trial.js TRIAL_FLEET).
    expect(shipNameIn('pt-BR', 'Lancer I of Europa')).toBe('Lancer I de Europa');
    expect(shipNameIn('pt-BR', 'Lancer III of Earth')).toBe('Lancer III da Terra');
    expect(shipNameIn('pt-BR', 'Packhorse of Titan')).toBe('Packhorse de Titã');
    expect(shipNameIn('en', 'Vanguard of Earth')).toBe('Vanguard of Earth');
    expect(designNameIn('pt-BR', 'Default')).toBe('Padrão');
    expect(designNameIn('en', 'Default')).toBe('Default');
    expect(designNameIn('pt-BR', 'My Raider')).toBe('My Raider');
  });
});

describe('plurals', () => {
  it('zero is plural: "0 estações", "1 estação"', () => {
    expect(pluralRule('pt-BR', 0)).toBe('other');
    expect(pluralRule('pt-BR', 1)).toBe('one');
    setLang('pt-BR', false);
    expect(tn('settle.count.stations', 0)).toBe('0 estações');
    expect(tn('settle.count.stations', 1)).toBe('1 estação');
    expect(tn('settle.count.stations', 3)).toBe('3 estações');
    expect(tn('grp.selectedCaps', 1)).toBe('1 SELECIONADA');
    expect(tn('grp.selectedCaps', 4)).toBe('4 SELECIONADAS');
  });
});

describe('server-worded text (Senate laws)', () => {
  it('shows the copy for the language on screen, without a refetch', () => {
    const law = {
      name: 'More Metal', effect: 'Every settlement mines 25% more metal.',
      i18n: { 'pt-BR': { name: 'Mais Metal', effect: 'Cada assentamento extrai 25% mais metal.' } },
    };
    expect(inLang(law).name).toBe('More Metal');
    setLang('pt-BR', false);
    expect(inLang(law)).toMatchObject({ name: 'Mais Metal', effect: 'Cada assentamento extrai 25% mais metal.' });
    expect(inLang({ name: 'X' } as { name: string; i18n?: undefined }).name).toBe('X');
  });
});
