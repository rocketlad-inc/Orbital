// Devlog posts for the browser: the changelog page, each post's own page
// (/devlog/<slug>) and the tab title read the same list, fetched once.
//
// The compiled seed posts render first and the live list (/api/devlog,
// worker/devlog.js) replaces them when it lands: a marketing page that
// flashes empty while it waits for an API is worse than one that is
// briefly stale. An empty or failed answer keeps what is on screen.
import { useEffect, useState } from 'react';
import { SEED_POSTS } from './devlogPosts';

export interface DevlogPost {
  /** URL-safe id: the post's page is /devlog/<slug>. */
  slug: string;
  title: string;
  /** Display date, written out rather than parsed. */
  date: string;
  lede: string;
  /** Authored HTML, sanitised on write (worker/devlog.js). */
  html: string;
  /** Render the combat matrix charts after the body. */
  charts?: boolean;
}

/** /devlog/<slug> -> slug. */
export const DEVLOG_POST_RE = /^\/devlog\/([a-z0-9][a-z0-9-]{0,63})\/?$/;
export const devlogPath = (slug: string) => `/devlog/${slug}`;

let posts: DevlogPost[] = SEED_POSTS.map((p: any) => ({
  slug: p.slug, title: p.title, date: p.date, lede: p.lede, html: p.html, charts: !!p.charts,
}));
/** True once the live list has answered (or failed): a slug missing from
 *  it really is missing, not just newer than the seed copy. */
let settled = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (!inflight) {
    inflight = fetch('/api/devlog', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const rows = Array.isArray(data?.posts) ? data.posts : [];
        if (rows.length > 0) {
          posts = rows.map((r: any) => ({
            slug: String(r.slug ?? ''),
            title: String(r.title ?? ''),
            date: String(r.date ?? ''),
            lede: String(r.lede ?? ''),
            html: String(r.html ?? ''),
            charts: !!r.charts,
          }));
        }
      })
      .catch(() => { /* the seed copy stays on screen */ })
      .finally(() => { settled = true; listeners.forEach(l => l()); });
  }
  return inflight;
}

/** The posts, newest first, and whether the live list has answered. */
export function useDevlogPosts(): { posts: DevlogPost[]; settled: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump(n => n + 1);
    listeners.add(l);
    load();
    return () => { listeners.delete(l); };
  }, []);
  return { posts, settled };
}
