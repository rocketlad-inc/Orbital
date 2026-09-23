// EVERY INLINE SCRIPT IN THE PAGE SHELL MUST PARSE.
//
// public/index.html carries the widget/watch PAIRING script inline: it
// runs before the app boots, reads the pairing code out of the launch
// URL and hands the phone's token over. On 2026-09-22 a '\n\n' inside a
// window.confirm() string was written to disk as two real line breaks.
// A single-quoted string cannot span lines, so the whole script threw
// "SyntaxError: Invalid or unexpected token" and NOTHING in it ran — no
// Android widget and no watch could pair — while every test stayed
// green, because nothing ever looked at this file. Found only by
// reading a live console in a QA pass.
//
// Parsed with node's vm.Script: compile only, never executed.

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');

/** Inline <script> bodies, skipping <script src=...> and JSON blocks. */
function inlineScripts(src: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (/type=["']application\/(ld\+)?json["']/.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

describe('public/index.html inline scripts', () => {
  const scripts = inlineScripts(html);

  it('the page shell still has its pairing script (the premise)', () => {
    expect(scripts.some(s => s.includes('/api/me/widget-tokens/pair'))).toBe(true);
  });

  it('every one of them parses', () => {
    const failures: string[] = [];
    scripts.forEach((body, i) => {
      try {
        // eslint-disable-next-line no-new
        new vm.Script(body, { filename: `index.html inline script ${i + 1}` });
      } catch (e) {
        failures.push(`script ${i + 1}: ${(e as Error).message}`);
      }
    });
    expect(failures).toEqual([]);
  });
});
