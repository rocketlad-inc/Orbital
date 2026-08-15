// ============================================================
// Reading level of a devlog post.
//
//   node scripts/reading-level.mjs <file.html> [--target 8]
//
// Flesch-Kincaid grade, plus the worst offenders so the number is
// actionable rather than a verdict. "Make it simpler" is otherwise a
// taste argument nobody can settle; this makes it a measurement, and
// points at the exact sentences to cut.
//
// Grade is a proxy, not a truth. It counts syllables and sentence
// length, so it cannot tell that "boresighted" is jargon while
// "freighter" is fine in context. Read the long-sentence list too.
// ============================================================

import fs from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: reading-level.mjs <file.html> [--target 8]');
  process.exit(1);
}
const targetIdx = rest.indexOf('--target');
const target = targetIdx >= 0 ? Number(rest[targetIdx + 1]) : 8;

const html = fs.readFileSync(file, 'utf8');

// Strip markup, and drop table cells: a table is a lookup, not prose,
// and its fragments ("0.15", "less than one") would flatter the score.
const text = html
  .replace(/<table[\s\S]*?<\/table>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const sentences = text
  .split(/(?<=[.!?])\s+/)
  .map(s => s.trim())
  .filter(s => s.split(/\s+/).length > 2);

const syllables = (word) => {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
};

let words = 0, sylls = 0;
const perSentence = sentences.map(s => {
  const ws = s.split(/\s+/).filter(w => /[a-z]/i.test(w));
  const sy = ws.reduce((a, w) => a + syllables(w), 0);
  words += ws.length;
  sylls += sy;
  return { s, words: ws.length, sylls: sy };
});

const grade = 0.39 * (words / sentences.length)
  + 11.8 * (sylls / words) - 15.59;

console.log(`file      ${file}`);
console.log(`sentences ${sentences.length}`);
console.log(`words     ${words}`);
console.log(`avg words/sentence ${(words / sentences.length).toFixed(1)}`);
console.log(`avg syllables/word ${(sylls / words).toFixed(2)}`);
console.log(`\nFlesch-Kincaid grade: ${grade.toFixed(1)}  (target <= ${target})`);
console.log(grade <= target ? 'PASS' : 'ABOVE TARGET');

const long = perSentence
  .filter(p => p.words > 25)
  .sort((a, b) => b.words - a.words)
  .slice(0, 6);
if (long.length) {
  console.log('\nLongest sentences — split these first:');
  for (const p of long) console.log(`  ${String(p.words).padStart(3)}w  ${p.s.slice(0, 96)}...`);
}

// Words a 13-year-old would have to look up. Hand-listed rather than
// dictionary-derived: the point is the handful this project actually
// reaches for, not a general vocabulary test.
const JARGON = ['boresighted', 'trajectory', 'velocity', 'exposure', 'rendezvous',
  'consolidated', 'reciprocal', 'commensurate', 'arbitrarily', 'geometry',
  'compound', 'invariant', 'proportionally', 'brachistochrone'];
const found = JARGON.filter(j => new RegExp(`\\b${j}`, 'i').test(text));
if (found.length) console.log(`\nJargon still present: ${found.join(', ')}`);
