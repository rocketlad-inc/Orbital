import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InterceptPicker, type PickerEntry } from '../InterceptPicker';

// The intercept list says WHERE on their trip a match lands and how much
// fighting it buys (Lorne, 2026-10-20: "meets at 88% of their trip, about
// 7 ticks of fighting before arrival").

const entry = (over: Partial<PickerEntry> = {}): PickerEntry => ({
  key: 'g1', name: 'Raid Group', ownerName: 'Rival', ownerColor: '#f00', standing: 'war',
  ok: true, ships: 4, makeup: '4× Corvette', captain: null, dest: 'Saturn',
  meetIn: 21, myEta: 3, theirEta: 28, match: true, tripPct: 88, fightTicks: 7,
  angle: 0, icon: { cls: 'corvette' }, search: 'raid group',
  ...over,
});

const render = (e: PickerEntry, selectedKey: string | null) => {
  try { localStorage.setItem('orbital.intercept.view', 'list'); } catch { /* jsdom */ }
  return renderToStaticMarkup(
    <InterceptPicker
      variant="popout" title="Intercept" entries={[e]} selectedKey={selectedKey}
      onSelect={() => {}} showing={false} onShow={() => {}} onCommit={() => {}} busy={false}
      meIcon={null} now={100}
    />,
  );
};

describe('intercept list: where a match lands', () => {
  it('a match card says the trip share and the fighting before arrival', () => {
    const html = render(entry(), null);
    expect(html).toContain('meets at 88% of their trip');
    expect(html).toContain('about 7 ticks of fighting before arrival');
  });

  it('the selected card says it too', () => {
    const html = render(entry(), 'g1');
    expect(html.split('meets at 88% of their trip').length - 1).toBe(2);
  });

  it('a meeting at their door says nothing about a trip share', () => {
    const html = render(entry({ match: false, tripPct: null, fightTicks: 0 }), 'g1');
    expect(html).not.toContain('of their trip');
  });

  it('a match in their last tick says the fight starts on arrival', () => {
    expect(render(entry({ fightTicks: 0, tripPct: 99 }), null)).toContain('the fight starts as they arrive');
  });
});
