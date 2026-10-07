// The guide area translates data that still lives next to its English: the
// tutorial steps, the landing FAQ and the Commission's fixed phrases. The
// English catalog must say exactly what that data says, or an English player
// would see different words than the source of truth (and a test that reads
// the source would pass while the screen disagreed).

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { en } from '../en';
import { setLang, t, tk } from '../core';
import { tMarkup, tRich } from '../rich';
import { TUTORIAL_STEPS } from '../../game/tutorialSteps';
import { FAQ } from '../../components/LandingHome';
import {
  COMMISSION_NAME, COMMISSION_PRICE, COMMISSION_DISCORD, COMMISSION_NO_GAMEPLAY, COMMISSION_FACTS,
  COMMISSION_LINES, COMMISSION_EMBLEMS, COMMISSION_CITY_SKINS, COMMISSION_STATION_SKINS,
  COMMISSION_STRUCTURE_LOOKS,
} from '../../multiplayer/commission';

const E = en as Record<string, string>;

afterEach(() => setLang('en', false));

describe('guide catalog keeps the English source of truth', () => {
  it('every tutorial step has its title, body and task label in the English catalog, unchanged', () => {
    for (const s of TUTORIAL_STEPS) {
      expect(E[`tutorial.step.${s.id}.title`]).toBe(s.title);
      expect(E[`tutorial.step.${s.id}.body`]).toBe(s.body);
      if (s.task) expect(E[`tutorial.step.${s.id}.task`]).toBe(s.task.label);
    }
  });

  it('every tutorial step has a Portuguese title and body', () => {
    setLang('pt-BR', false);
    for (const s of TUTORIAL_STEPS) {
      expect(tk(`tutorial.step.${s.id}.title`, s.title)).not.toBe(s.title);
      expect(tk(`tutorial.step.${s.id}.body`, s.body)).not.toBe(s.body);
      if (s.task) expect(tk(`tutorial.step.${s.id}.task`, s.task.label)).not.toBe(s.task.label);
    }
  });

  it('the landing FAQ is in the English catalog, unchanged', () => {
    FAQ.forEach(([q, a], i) => {
      expect(E[`landing.faq.${i + 1}.q`]).toBe(q);
      expect(E[`landing.faq.${i + 1}.a`]).toBe(a);
    });
  });

  it('the Commission phrases and the one-sentence offer read the same in English', () => {
    expect(t('mp.commission.name')).toBe(COMMISSION_NAME);
    expect(t('mp.commission.price')).toBe(COMMISSION_PRICE);
    expect(t('mp.commission.discord')).toBe(COMMISSION_DISCORD);
    expect(t('mp.commission.noGameplay')).toBe(COMMISSION_NO_GAMEPLAY);
    const facts = t('mp.commission.facts', {
      lines: COMMISSION_LINES, emblems: COMMISSION_EMBLEMS, city: COMMISSION_CITY_SKINS,
      station: COMMISSION_STATION_SKINS, looks: COMMISSION_STRUCTURE_LOOKS,
      discord: COMMISSION_DISCORD, noGameplay: COMMISSION_NO_GAMEPLAY, price: COMMISSION_PRICE,
    });
    expect(facts).toBe(COMMISSION_FACTS);
  });
});

describe('inline-markup helpers', () => {
  it('tMarkup turns <b> into bold and leaves the rest as text', () => {
    const html = renderToStaticMarkup(<p>{tMarkup('howto.quick.1')}</p>);
    expect(html).toBe('<p><b>Open your homeworld</b> and queue an upgrade — a forge is a fine first pick.</p>');
  });

  it('tRich puts a node where the translator put the slot', () => {
    const html = renderToStaticMarkup(<p>{tRich('banner.newer', { mine: <i>a</i>, server: <i>b</i> })}</p>);
    expect(html).toBe('<p>⚠ A newer build is live. You&#x27;re on <i>a</i>, server is <i>b</i>. Hard-reload to update.</p>');
    setLang('pt-BR', false);
    const pt = renderToStaticMarkup(<p>{tRich('banner.newer', { mine: <i>a</i>, server: <i>b</i> })}</p>);
    expect(pt).toContain('<i>a</i>');
    expect(pt).toContain('<i>b</i>');
    expect(pt).not.toContain('{');
  });
});
