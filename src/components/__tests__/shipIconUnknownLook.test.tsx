// A SHIP LOOK THIS BUILD DOES NOT KNOW MUST NOT CRASH THE PAGE.
//
// Ship looks are saved on the ship (icon_variant). A newer build adds
// letters (the visual overhaul brings T-Y), and if that build is ever
// reverted, the database still holds them. ShipIcon looked the letter up
// in a fixed table and rendered whatever came back: undefined, which
// throws on render, and the map rasterises every hull through here, so
// one such ship took the whole game down. It must fall back to the
// class's default look instead.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShipIcon, DEFAULT_SHIP_ICONS, ShipIconClass, ShipIconVariant } from '../ShipIcons';

const CLASSES = Object.keys(DEFAULT_SHIP_ICONS) as ShipIconClass[];
/** Each render numbers its clip-path ids afresh; compare the drawing, not the ids. */
const drawing = (svg: string) => svg.replace(/si\d+([a-z])/g, 'si#$1');

describe('ShipIcon with a look it does not know', () => {
  for (const cls of CLASSES) {
    it(`${cls}: an unknown letter draws the default look`, () => {
      const unknown = renderToStaticMarkup(
        <ShipIcon shipClass={cls} variant={'T' as ShipIconVariant} color="#4fc3f7" size={32} />);
      const fallback = renderToStaticMarkup(
        <ShipIcon shipClass={cls} color="#4fc3f7" size={32} />);
      expect(drawing(unknown)).toBe(drawing(fallback));
    });
  }

  it('an unknown class does not crash either', () => {
    expect(() => renderToStaticMarkup(
      <ShipIcon shipClass={'mega_destroyer' as ShipIconClass} variant={'F' as ShipIconVariant} color="#fff" size={32} />,
    )).not.toThrow();
  });
});
