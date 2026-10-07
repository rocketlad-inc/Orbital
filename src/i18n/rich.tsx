// A translated sentence with React nodes (bold, links, icons) in it.
//
//   tRich('banner.newer', { mine: <strong>{a}</strong>, server: <strong>{b}</strong> })
//
// where the catalog says "You're on {mine}, server is {server}". The
// translator can move the slots around the sentence; plain {vars} still go
// in the third argument. A slot the caller did not supply stays as written.

import React from 'react';
import { t, type Key } from './core';

/** A translated string that carries simple inline tags: <b>, <i>, <strong>,
 *  <em>, <code> (not nested). Lets a paragraph keep its bold words without
 *  the translator having to reason about React.
 *
 *    tMarkup('howto.b1.p1')   "…<b>the planets actually orbit</b>, so…" */
export function tMarkup(key: Key, vars?: Record<string, string | number>): React.ReactNode {
  const s = t(key, vars);
  const re = /<(b|i|strong|em|code)>([\s\S]*?)<\/\1>/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(React.createElement(m[1], { key: i++ }, m[2]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function tRich(
  key: Key,
  slots: Record<string, React.ReactNode>,
  vars?: Record<string, string | number>,
): React.ReactNode {
  const parts = t(key, vars).split(/\{(\w+)\}/);
  return parts.map((p, i) => (
    i % 2 === 0
      ? p
      : <React.Fragment key={i}>{p in slots ? slots[p] : `{${p}}`}</React.Fragment>
  ));
}
