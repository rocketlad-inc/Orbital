// Every world the game ships with has its lore in Portuguese too, and the
// About text follows the language switch (playtest 2026-10-24, D2).
import { BODY_FLAVOR, composedBodyFlavor, getBodyFlavor, bodyImmovableNote } from '../bodyFlavor';
import { BODY_FLAVOR_PT } from '../bodyFlavor.pt-BR';
import { setLang } from '../../i18n/core';

afterEach(() => setLang('en', false));

describe('world lore in Portuguese', () => {
  it('translates every authored English entry, and nothing else', () => {
    const authored = Object.keys(BODY_FLAVOR).filter(id => BODY_FLAVOR[id]);
    expect(authored.filter(id => !BODY_FLAVOR_PT[id])).toEqual([]);
    expect(Object.keys(BODY_FLAVOR_PT).filter(id => !(id in BODY_FLAVOR))).toEqual([]);
  });

  it('shows the language on screen', () => {
    expect(getBodyFlavor('earth')).toMatch(/^The pale blue cradle/);
    setLang('pt-BR', false);
    expect(getBodyFlavor('earth')).toMatch(/^O berço azul-claro/);
    expect(composedBodyFlavor({ id: 'midas', type: 'asteroid' })).toMatch(/Matadoras de Planetas/);
    expect(bodyImmovableNote({ type: 'dwarf' })).toMatch(/^Massivo demais/);
    expect(composedBodyFlavor({ id: 'mars', name: 'Marte', obliteratedAtTick: 9 })).toMatch(/^Isto era Marte\./);
  });

  it('keeps the English text exactly', () => {
    expect(composedBodyFlavor({ id: 'midas', type: 'asteroid' })).toBe(
      'These rocks are sometimes called “Planet Killers” for the devastation they can cause upon impact, '
      + 'but this one has been orbiting peacefully and stably for millennia.');
    expect(composedBodyFlavor({ id: 'mars', name: 'Mars', obliteratedAtTick: 9 })).toMatch(/^This was Mars\. A Mega Destroyer broke it apart/);
  });
});
