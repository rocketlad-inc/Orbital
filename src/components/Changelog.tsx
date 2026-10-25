// ============================================================
// Changelog — now a BLOG. The "CHANGELOG" tab on the landing page and
// the page behind orbital-empire.com/changelog.
//
// It used to be one constant holding one game's patch notes, replaced
// wholesale each release. That works exactly once: the moment a second
// update exists, the first one is gone, and the notes players argued
// about last month cannot be linked to or re-read.
//
// So: an ordered list of POSTS, newest first. Adding an update means
// prepending one entry — a title, a date, a lede and a body — and
// nothing else moves. Old posts stay published forever.
//
// Bodies are authored HTML rather than Markdown or JSX: they are
// build-time literals with no user input anywhere near them, which is
// what makes setting them as HTML safe, and it preserves the authored
// structure (headings, lists, tables) exactly as written. Keep the h2
// structure — the CSS keys off it.
// ============================================================

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CombatCharts } from './CombatCharts';
import { DEVLOG_FIGURES } from './DevlogFigures';
import { useDevlogPosts, devlogPath } from '../content/devlogStore';
import './Changelog.css';

interface Props {
  /** Foot-of-page call to action. Differs by who is reading: a visitor
   *  gets "PLAY ORBITAL", a signed-in player gets sent back to their
   *  game. */
  ctaLabel: string;
  onCta: () => void;
  /** Show only this post: its own page, /devlog/<slug>. */
  slug?: string;
  /** Open a site path in place (post titles are real links). */
  onOpen?: (path: string) => void;
}





// ------------------------------------------------------------------
// FIGURES INSIDE A POST BODY
//
// A post body cannot contain a drawing. It is authored HTML held in the
// database and sanitised on write against a tag allow-list, which
// strips <svg> and every attribute — correctly, because that string is
// editable and rendered with innerHTML on a public page.
//
// So the body carries an EMPTY div with a known class and this
// component swaps it for the React figure of the same name. The
// alternative — splitting the HTML string on the placeholders and
// rendering an array of fragments — means parsing HTML with a regex and
// re-deciding, per post, where a tag boundary is. Portals let the
// browser's own parser do that: React sets the innerHTML exactly as it
// does today, and each figure mounts INTO the div the parser produced.
//
// Two properties this has to have, because the page renders the newest
// post plus every older one:
//
//   - Per-post state. The host ref, the effect and the mount list all
//     live in this component, so N posts on the page are N independent
//     instances rather than one shared registry keyed by something.
//   - Survives the body changing. Posts arrive from the fallback copy
//     first and are replaced by the fetch, so `html` DOES change under
//     a mounted figure. When it does, React rewrites the innerHTML and
//     the old placeholder divs are detached; the mount list is stamped
//     with the html it was found in, and portals only render while that
//     stamp matches, so a figure is never left pointed at a node that
//     is no longer in the document.
// ------------------------------------------------------------------
interface Mounts {
  /** The body the placeholders were found in — see above. */
  html: string;
  slots: { key: string; el: Element }[];
}

const DevlogBody: React.FC<{ html: string; id?: string; onOpen?: (path: string) => void }> = ({ html, id, onOpen }) => {
  const hostRef = useRef<HTMLElement>(null);
  const [mounts, setMounts] = useState<Mounts>({ html, slots: [] });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const slots: Mounts['slots'] = [];
    host.querySelectorAll('div').forEach(el => {
      // hasOwnProperty rather than `in`: `in` walks the prototype, so a
      // post carrying class="constructor" would match a figure that
      // does not exist and mount `undefined` as a component.
      const key = Array.from(el.classList)
        .find(c => Object.prototype.hasOwnProperty.call(DEVLOG_FIGURES, c));
      if (key) slots.push({ key, el });
    });
    // Bail when nothing changed, so a post with no figures at all —
    // which is most of them — does not pay for a second render.
    setMounts(prev => (
      prev.html === html && prev.slots.length === 0 && slots.length === 0
        ? prev
        : { html, slots }
    ));
  }, [html]);

  return (
    <>
      <article
        id={id}
        className="cl-body"
        ref={hostRef}
        // Links in a body are paths on this site (the sanitiser drops any
        // other href): a plain click opens them in place, no reload.
        onClick={e => {
          const a = (e.target as Element).closest?.('a[href^="/"]');
          if (!a || !onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(a.getAttribute('href') as string);
        }}
        // Authored HTML. Sanitised SERVER-SIDE on write against a tag
        // allow-list (worker/devlog.js) — that is the guard, not this
        // component, because the string now comes from a database.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {mounts.html === html && mounts.slots.map(({ key, el }, i) => {
        const Fig = DEVLOG_FIGURES[key];
        return createPortal(<Fig />, el, `${key}-${i}`);
      })}
    </>
  );
};

/** A real link (crawlers follow it) that a plain click opens in place. */
const PageLink: React.FC<{ href: string; onOpen?: (path: string) => void; className?: string; children: React.ReactNode }> = ({ href, onOpen, className, children }) => (
  <a
    className={className}
    href={href}
    onClick={e => {
      if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onOpen(href);
    }}
  >
    {children}
  </a>
);

export const Changelog: React.FC<Props> = ({ ctaLabel, onCta, slug, onOpen }) => {
  const { posts, settled } = useDevlogPosts();

  // ONE POST, at /devlog/<slug>: its own page, so it can be linked,
  // searched for and cited on its own. A slug the live list does not
  // have (yet) waits for it; one it really lacks gets the whole devlog.
  if (slug) {
    const post = posts.find(p => p.slug === slug);
    if (!post && !settled) return <div className="cl" />;
    if (post) {
      const others = posts.filter(p => p.slug !== slug);
      return (
        <div className="cl">
          <div className="cl-hero">
            <div className="cl-eyebrow"><PageLink href="/changelog" onOpen={onOpen} className="cl-crumb">— DEVLOG</PageLink></div>
            <h1 className="cl-title">{post.title}</h1>
            <div className="cl-date">{post.date}</div>
            <div className="cl-lede">{post.lede}</div>
          </div>
          <DevlogBody id={post.slug} html={post.html} onOpen={onOpen} />
          {post.charts && <CombatCharts />}
          <div className="cl-cta">
            <button className="cl-cta-btn" onClick={onCta}>{ctaLabel}</button>
          </div>
          {others.length > 0 && (
            <nav className="cl-more" aria-label="More from the devlog">
              <div className="cl-eyebrow">MORE FROM THE DEVLOG</div>
              <ul>
                {others.map(p => (
                  <li key={p.slug}>
                    <PageLink href={devlogPath(p.slug)} onOpen={onOpen}>{p.title}</PageLink>
                    <span className="cl-more-date">{p.date}</span>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      );
    }
  }

  // The newest post fronts the page: it is what someone arriving after
  // an announcement came to read. Everything older stays published
  // below it, in full, rather than collapsing into a list of links —
  // this is a devlog people scroll, not a release archive people
  // search. Each title links to the post's own page.
  const [newest, ...older] = posts;
  if (!newest) return null;

  return (
    <div className="cl">
      <div className="cl-hero">
        <div className="cl-eyebrow">— DEVLOG</div>
        <h1 className="cl-title"><PageLink href={devlogPath(newest.slug)} onOpen={onOpen} className="cl-title-link">{newest.title}</PageLink></h1>
        <div className="cl-date">{newest.date}</div>
        <div className="cl-lede">{newest.lede}</div>
      </div>

      <DevlogBody id={newest.slug} html={newest.html} onOpen={onOpen} />
      {newest.charts && <CombatCharts />}

      {older.map(post => (
        <section key={post.slug} className="cl-post" id={post.slug}>
          {/* A rule and a restated title, so a reader scrolling out of
              one update knows they have crossed into an older one
              rather than a new section of the same piece. */}
          <div className="cl-post-head">
            <div className="cl-eyebrow">— EARLIER</div>
            <h2 className="cl-post-title"><PageLink href={devlogPath(post.slug)} onOpen={onOpen} className="cl-title-link">{post.title}</PageLink></h2>
            <div className="cl-date">{post.date}</div>
            <div className="cl-post-lede">{post.lede}</div>
          </div>
          <DevlogBody html={post.html} onOpen={onOpen} />
          {/* The combat matrix belongs to the post that discusses it,
              not to whichever post happens to be last on the page. */}
          {post.charts && <CombatCharts />}
        </section>
      ))}

      <div className="cl-cta">
        <button className="cl-cta-btn" onClick={onCta}>{ctaLabel}</button>
      </div>
    </div>
  );
};
