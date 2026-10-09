// A ratchet against new English text sneaking into the player-facing UI.
//
// It parses every component under src/components and src/multiplayer and
// collects the text a player would read that does NOT go through t()/tn()/tk():
// JSX text between tags, and string literals in title / aria-label /
// placeholder / alt / label attributes. The hits that exist today are the
// reviewed baseline below (brand names, symbols, admin-only screens, code
// samples). A NEW hit fails this test: translate it (see src/i18n/TRANSLATING.md),
// or, if it really is meant to stay as written (a brand, a unit, a code), add it
// to untranslated-baseline.json by running:
//
//     UPDATE_I18N_BASELINE=1 CI=true react-scripts test --watchAll=false --testMatch "**/src/i18n/__tests__/untranslatedUi.test.ts"
//
// and review the diff of that file in the PR.

import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '../..');
const BASELINE = path.join(__dirname, '..', 'untranslated-baseline.json');

// Screens that are English on purpose: admin tools, dev tools, legal/press/changelog
// pages, retired single-player, staging banner.
const SKIP = /(Admin|Devlog|PerfHud|Editor|ShipIconGallery|SinglePlayerSetup|PrivacyPolicy|PressKit|Changelog|Credits|BotControl|GameStory|EmailAdmin|StagingBanner)/;
const ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'aria-description']);
const wordy = (s: string) => /[A-Za-z]{3,}/.test(s);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (/\.tsx$/.test(name) && !SKIP.test(name)) out.push(p);
  }
  return out;
}

function hitsIn(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const s = n.getText().replace(/\s+/g, ' ').trim();
      if (s && wordy(s) && !/^[\W\d_]*$/.test(s)) hits.add(`JSX|${s.slice(0, 120)}`);
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText()) && n.initializer) {
      const init = n.initializer;
      if (ts.isStringLiteral(init) && wordy(init.text)) hits.add(`ATTR|${init.text.slice(0, 120)}`);
      else if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) {
          const tx = e.getText();
          if (!/\bt\(/.test(tx) && wordy(tx)) hits.add(`ATTR|${tx.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...hits].sort();
}

function scan(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const root of ['components', 'multiplayer']) {
    for (const f of listFiles(path.join(SRC, root))) {
      const h = hitsIn(f);
      if (h.length) result[path.relative(SRC, f).replace(/\\/g, '/')] = h;
    }
  }
  return result;
}

describe('player-facing UI text goes through the catalog', () => {
  const found = scan();

  if (process.env.UPDATE_I18N_BASELINE) {
    it('rewrites the baseline', () => {
      fs.writeFileSync(BASELINE, JSON.stringify(found, null, 2) + '\n');
    });
    return;
  }

  const baseline: Record<string, string[]> = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

  it('has no new untranslated JSX text or title/aria-label/placeholder literals', () => {
    const fresh: string[] = [];
    for (const [file, hits] of Object.entries(found)) {
      const known = new Set(baseline[file] ?? []);
      for (const h of hits) if (!known.has(h)) fresh.push(`${file}: ${h}`);
    }
    expect(fresh).toEqual([]);
  });
});
