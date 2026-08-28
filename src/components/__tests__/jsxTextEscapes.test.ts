// A \uXXXX escape is evaluated inside a JS string or template literal,
// but a JSX TEXT CHILD is literal -- so `>\u2212</button>` shipped a
// button labelled with six visible characters instead of a minus sign,
// while the `\u00d7` two lines above it rendered fine because it sat
// in a template literal. Same file, same commit, different context.
//
// Cheap source scan: any \uXXXX sitting directly between JSX tags.

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..');

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('JSX text children', () => {
  it('never contain a raw backslash-u escape', () => {
    // `>`, optional spaces, a literal backslash-u, four hex digits.
    const bad = /> *\\u[0-9a-fA-F]{4}/;
    const offenders = tsxFiles(SRC)
      .filter(f => bad.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
