/**
 * THE SHIP CARD NEVER SCROLLS ITSELF OFF THE SCREEN (playtest C3).
 *
 * Priya, 2026-10-24: the ship panel rendered partly off-screen with
 * COMMIT at x=-11, and once it scrolled until the card showed nothing.
 * `.ship-panel` was `overflow: hidden`, which is still a scroll
 * container: a focus() (the rename box) or a scrollIntoView could
 * scroll it. A clipped box cannot be scrolled, and the header must be
 * allowed to shrink so it never makes the card wider than the rail.
 *
 * Read from the stylesheet the app ships.
 */
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '..', 'ShipPanel.css'), 'utf8');

/** Body of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  expect(m).not.toBeNull();
  return m![2].replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('ship panel cannot be scrolled sideways', () => {
  it('clips instead of hiding, so nothing can scroll the card', () => {
    const decls = rule('.ship-panel').match(/overflow:\s*[a-z]+/g) ?? [];
    // The LAST overflow wins: clip, with hidden only as a fallback before it.
    expect(decls[decls.length - 1]).toBe('overflow: clip');
  });

  it('lets the header shrink and wrap rather than widen the card', () => {
    expect(rule('.ship-panel .panel-header > span:first-child')).toMatch(/min-width:\s*0/);
    expect(rule('.ship-panel .panel-header input')).toMatch(/max-width:\s*100%/);
  });

  it('keeps the body from growing a sideways scroll', () => {
    const body = rule('.ship-panel .panel-body');
    expect(body).toMatch(/overflow-x:\s*hidden/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
