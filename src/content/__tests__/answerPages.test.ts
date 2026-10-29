// The answer pages (answerPages.ts) are found through the sitemap and
// linked from each other; a page missing from either is invisible.
import fs from 'fs';
import path from 'path';
import { ANSWER_PAGES } from '../answerPages';

const sitemap = fs.readFileSync(path.resolve(__dirname, '../../../public/sitemap.xml'), 'utf8');

describe('answer pages', () => {
  it('each has a unique slug and path, and is in the sitemap', () => {
    expect(new Set(ANSWER_PAGES.map(p => p.slug)).size).toBe(ANSWER_PAGES.length);
    expect(new Set(ANSWER_PAGES.map(p => p.path)).size).toBe(ANSWER_PAGES.length);
    for (const p of ANSWER_PAGES) {
      expect(p.path).toMatch(/^\/[a-z0-9-]+$/);
      expect(sitemap).toContain(`<loc>https://orbital-empire.com${p.path}</loc>`);
    }
  });

  it('keeps titles and descriptions to what a search result shows', () => {
    for (const p of ANSWER_PAGES) {
      expect(p.title.length).toBeLessThanOrEqual(75);
      expect(p.description.length).toBeLessThanOrEqual(200);
    }
  });

  it('never gives away the surprises', () => {
    const text = JSON.stringify(ANSWER_PAGES).toLowerCase();
    for (const secret of ['squid', 'leviathan', 'kaiju', 'sun gate', 'solo']) expect(text).not.toContain(secret);
  });
});
