// ============================================================
// DevlogRichEditor — write a devlog post the way it will look.
//
// The first editor was a <textarea> full of angle brackets with a
// preview underneath. That is a fine way to store a post and a poor way
// to write one: you compose in one panel and check in another, the
// fonts do not match, and the figures — the whole reason the page is
// worth reading — are invisible while you work.
//
// This edits the rendered thing directly. Three consequences worth
// knowing about, because they drove the design:
//
//   THE SURFACE WEARS THE PUBLISHED STYLES. The editable area carries
//   the same `cl-body` class the live page uses, so line length, type
//   and spacing are what a reader gets. Not a preview OF the page —
//   the page.
//
//   FIGURES ARE REAL AND ATOMIC. Each `fig-*` placeholder mounts the
//   actual component, marked contentEditable=false so it cannot be
//   typed into or half-deleted. You see the chart while you write the
//   paragraph that introduces it. Select it and press delete and the
//   whole figure goes, which is the only sane granularity.
//
//   SAVING SERIALISES, IT DOES NOT SCRAPE. contentEditable emits
//   whatever the browser feels like — nested spans, style attributes,
//   <div> where you wanted <p>. Handing that to the server would mean
//   the sanitiser silently eating half of it. So the DOM is walked and
//   re-emitted as the allowed subset, which makes this the client-side
//   twin of worker/devlog.js — deliberately the same tag list. If you
//   widen one, widen the other.
//
// execCommand is deprecated and has no replacement with this reach. It
// is used for the formatting commands only; everything structural goes
// through the serialiser, so the deprecation cannot cost us correctness
// — only the buttons would need rewriting.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEVLOG_FIGURES } from '../components/DevlogFigures';
import './DevlogRichEditor.css';

/** Tags the server keeps (worker/devlog.js ALLOWED_TAGS). Anything else
 *  is unwrapped to its contents rather than dropped, so a stray <div>
 *  from a paste loses the wrapper and keeps the words. */
const KEEP = new Set([
  'P', 'H2', 'H3', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I',
  'BLOCKQUOTE', 'CODE', 'PRE', 'BR', 'HR',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
]);

/** Browsers emit these for bold/italic; the server allows the long
 *  forms, and one spelling in the stored HTML beats two. */
const RENAME: Record<string, string> = { B: 'strong', I: 'em' };

const FIGURE_LABELS: Record<string, string> = {
  'fig-route-circuit': 'Route circuit',
  'fig-folded-lane': 'Folded lane (before / after)',
  'fig-crossing-vs-matched': 'Crossing vs matched (3 panels)',
  'fig-aim-exposure': 'Aim vs exposure',
  'fig-hit-odds': 'Hit odds chart',
  'fig-ship-range': 'Weapon reach by hull',
  'fig-vulnerable-window': 'Caught leaving or arriving',
};

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** DOM -> the stored subset. */
function serialize(root: HTMLElement): string {
  const out: string[] = [];

  const walk = (node: Node, into: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      into.push(escapeText(node.nodeValue ?? ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    // A figure is stored as the empty placeholder it came from. Its
    // rendered contents are OURS, not the author's, and must never end
    // up in the post body.
    const figClass = [...el.classList].find(c => c in DEVLOG_FIGURES);
    if (figClass) {
      into.push(`<div class="${figClass}"></div>`);
      return;
    }

    const tag = el.tagName;
    if (!KEEP.has(tag)) {
      // Unknown wrapper: keep the words, drop the box.
      for (const child of Array.from(el.childNodes)) walk(child, into);
      return;
    }
    const name = RENAME[tag] ?? tag.toLowerCase();
    if (name === 'br' || name === 'hr') { into.push(`<${name}>`); return; }

    const inner: string[] = [];
    for (const child of Array.from(el.childNodes)) walk(child, inner);
    const body = inner.join('');
    // Drop anything with no real content. A <br> does not count as
    // content for this test: contentEditable parks a <p><br></p> at the
    // end of the document as somewhere to type, and storing that would
    // publish a blank paragraph. A <br> BETWEEN words is a real line
    // break and survives, because the paragraph has text as well.
    // Table cells are exempt — an empty cell is a cell.
    const isEmpty = !body.replace(/<br>/g, '').trim();
    if (isEmpty && name !== 'td' && name !== 'th') return;
    into.push(`<${name}>${body}</${name}>`);
  };

  for (const child of Array.from(root.childNodes)) walk(child, out);
  return out.join('\n');
}

/** Exported for tests. The serialiser decides what actually gets
 *  stored, so it is the part worth pinning — see
 *  __tests__/devlogSerialize.test.ts. */
export const serializeForTest = serialize;

export interface DevlogRichEditorProps {
  /** Stored HTML. Only read when `docKey` changes — see the effect. */
  value: string;
  /** Changes identity when a DIFFERENT post is loaded. Editing the
   *  current post must NOT reset the surface: writing back into
   *  contentEditable on every keystroke fights the caret and reverses
   *  what you typed. */
  docKey: string;
  onChange: (html: string) => void;
}

export const DevlogRichEditor: React.FC<DevlogRichEditorProps> = ({ value, docKey, onChange }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounts, setMounts] = useState<{ el: HTMLElement; fig: string }[]>([]);
  const [source, setSource] = useState(false);

  // Load a post into the surface. Keyed on docKey ONLY.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value || '<p><br></p>';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  /** Find placeholders and prepare them to host a real figure. */
  const remount = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const found: { el: HTMLElement; fig: string }[] = [];
    root.querySelectorAll('div').forEach(div => {
      const fig = [...div.classList].find(c => c in DEVLOG_FIGURES);
      if (!fig) return;
      // Atomic: the browser must treat the whole figure as one object,
      // so it cannot be typed inside or partially deleted.
      div.setAttribute('contenteditable', 'false');
      div.classList.add('dre-figure');
      found.push({ el: div, fig });
    });
    setMounts(found);
  }, []);

  useEffect(() => { remount(); }, [remount, docKey]);

  const emit = useCallback(() => {
    if (!ref.current) return;
    onChange(serialize(ref.current));
  }, [onChange]);

  const cmd = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    remount();
    emit();
  };

  /** Paste as PLAIN TEXT. Pasting from a browser or a word processor
   *  carries fonts, colours and nested markup that the serialiser would
   *  strip anyway — doing it here means what you see after pasting is
   *  what gets saved, instead of a surprise at save time. */
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    emit();
  };

  const insertFigure = (fig: string) => {
    if (!fig) return;
    // insertHTML rather than building a node: it lands at the caret and
    // splits the current block the way a user expects.
    document.execCommand('insertHTML', false,
      `<div class="${fig}"></div><p><br></p>`);
    remount();
    emit();
  };

  return (
    <div className="dre">
      <div className="dre-bar">
        <button type="button" onClick={() => cmd('formatBlock', 'h2')} title="Section heading">H2</button>
        <button type="button" onClick={() => cmd('formatBlock', 'h3')} title="Sub-heading">H3</button>
        <button type="button" onClick={() => cmd('formatBlock', 'p')} title="Body text">¶</button>
        <span className="dre-sep" />
        <button type="button" onClick={() => cmd('bold')} title="Bold"><b>B</b></button>
        <button type="button" onClick={() => cmd('italic')} title="Italic"><i>I</i></button>
        <span className="dre-sep" />
        <button type="button" onClick={() => cmd('insertUnorderedList')} title="Bullet list">• list</button>
        <button type="button" onClick={() => cmd('insertOrderedList')} title="Numbered list">1. list</button>
        <span className="dre-sep" />
        <select
          className="dre-figsel"
          value=""
          onChange={e => { insertFigure(e.target.value); e.target.value = ''; }}
          title="Drop a diagram in at the cursor"
        >
          <option value="">+ Insert figure…</option>
          {Object.keys(DEVLOG_FIGURES).map(f => (
            <option key={f} value={f}>{FIGURE_LABELS[f] ?? f}</option>
          ))}
        </select>
        <span className="dre-spacer" />
        <button
          type="button"
          className={source ? 'is-on' : undefined}
          onClick={() => setSource(v => !v)}
          title="Edit the raw HTML instead"
        >
          &lt;/&gt; HTML
        </button>
      </div>

      {source ? (
        <textarea
          className="dre-source"
          value={value}
          spellCheck={false}
          onChange={e => onChange(e.target.value)}
        />
      ) : (
        <>
          {/* The published class is on the editable surface itself, so
              what you type is set in the page's own type at the page's
              own measure. */}
          <div
            ref={ref}
            className="cl-body dre-surface"
            contentEditable
            suppressContentEditableWarning
            spellCheck
            onInput={() => { remount(); emit(); }}
            onBlur={emit}
            onPaste={onPaste}
          />
          {mounts.map(({ el, fig }, i) => {
            const Fig = DEVLOG_FIGURES[fig];
            return Fig ? createPortal(<Fig />, el, `${fig}-${i}`) : null;
          })}
        </>
      )}
    </div>
  );
};

export default DevlogRichEditor;
