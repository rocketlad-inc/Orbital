// ============================================================
// DevlogAdmin — write and edit the changelog without a deploy.
//
// The devlog used to be a compiled constant: publishing meant editing a
// .tsx file, rebuilding the client and redeploying, which makes writing
// an update a developer task and makes fixing a typo cost a deploy.
//
// Three deliberate choices about the editing model:
//
//   DRAFTS BY DEFAULT. A new post is unpublished until you say
//   otherwise. An editor that puts half-written prose on the front page
//   the moment you hit save is one nobody drafts in.
//
//   RAW HTML, WITH A LIVE PREVIEW. Not a rich-text editor: the existing
//   posts are hand-authored HTML with a specific structure the page's
//   CSS keys off, and a WYSIWYG that "helpfully" rewrites that markup
//   would fight the stylesheet. The preview panel is what makes raw
//   HTML tolerable — you see the rendered post as you type.
//
//   THE SERVER SANITISES. This component sends what you typed; the
//   worker strips it to an allow-list before storing. The preview here
//   is therefore optimistic: it can show you something the server will
//   drop. That is the right way round — better to discover it in the
//   preview loop than to have the editor silently disagree with what
//   gets published.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import './AdminAnalytics.css';
import './DevlogAdmin.css';

interface Post {
  id: string;
  slug: string;
  title: string;
  date: string;
  lede: string;
  html: string;
  charts: boolean;
  published: boolean;
  sort_index: number;
  updated_at_ms: number;
}

const BLANK = {
  slug: '', title: '', date: '', lede: '', html: '',
  charts: false, published: false,
};

export const DevlogAdmin: React.FC = () => {
  const [posts, setPosts] = useState<Post[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Post>>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/devlog', { credentials: 'include' });
      if (!res.ok) { setError('Could not load posts.'); return; }
      const data = await res.json();
      setPosts(Array.isArray(data.posts) ? data.posts : []);
    } catch {
      setError('Could not load posts.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pick = (p: Post) => {
    // Guarding an unsaved edit behind a confirm rather than blocking the
    // click: losing a paragraph to a mis-click is the failure that makes
    // someone stop trusting an editor.
    if (dirty && !window.confirm('Discard unsaved changes to this post?')) return;
    setSelected(p.id);
    setDraft(p);
    setDirty(false);
    setNote(null);
    setError(null);
  };

  const startNew = () => {
    if (dirty && !window.confirm('Discard unsaved changes to this post?')) return;
    setSelected(null);
    setDraft(BLANK);
    setDirty(false);
    setNote(null);
  };

  const set = <K extends keyof Post>(k: K, v: Post[K]) => {
    setDraft(d => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const body = {
        slug: draft.slug ?? '', title: draft.title ?? '', date: draft.date ?? '',
        lede: draft.lede ?? '', html: draft.html ?? '',
        charts: !!draft.charts, published: !!draft.published,
        ...(draft.sort_index != null ? { sort_index: draft.sort_index } : {}),
      };
      const res = await fetch(
        selected ? `/api/admin/devlog/${selected}` : '/api/admin/devlog',
        {
          method: selected ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'Save failed.');
        return;
      }
      // Re-seat on the SERVER's version of the post, not the draft: the
      // body it stored is the sanitised one, and showing the draft back
      // would hide anything it stripped until the next reload.
      if (data?.post) { setSelected(data.post.id); setDraft(data.post); }
      setDirty(false);
      setNote(selected ? 'Saved.' : 'Created as a draft.');
      await load();
    } catch {
      setError('Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${draft.title}"? This cannot be undone.`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/admin/devlog/${selected}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) { setError('Delete failed.'); return; }
      startNew();
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Move a post up or down the page by swapping sort_index with its
   *  neighbour. Two PATCHes, because ordering is the one edit where a
   *  number box would be worse than two arrows. */
  const reorder = async (p: Post, dir: -1 | 1) => {
    const ordered = [...posts].sort((a, b) => b.sort_index - a.sort_index);
    const i = ordered.findIndex(x => x.id === p.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const other = ordered[j];
    setBusy(true);
    try {
      await fetch(`/api/admin/devlog/${p.id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sort_index: other.sort_index }),
      });
      await fetch(`/api/admin/devlog/${other.id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sort_index: p.sort_index }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const ordered = [...posts].sort((a, b) => b.sort_index - a.sort_index);

  return (
    <div className="aa">
      <div className="aa-head">
        <h2 className="aa-title">Devlog</h2>
        <div className="aa-sub">
          Posts on the public changelog page. Edits go live immediately — no deploy.
        </div>
      </div>

      {error && <div className="dv-error">{error}</div>}
      {note && <div className="dv-note">{note}</div>}

      <div className="dv-wrap">
        <aside className="dv-list">
          <button type="button" className="dv-btn dv-btn--go" onClick={startNew}>
            + New post
          </button>
          {ordered.length === 0 && <div className="dv-empty">No posts yet.</div>}
          {ordered.map((p, i) => (
            <div
              key={p.id}
              className={`dv-item${p.id === selected ? ' is-on' : ''}`}
            >
              <button type="button" className="dv-item-main" onClick={() => pick(p)}>
                <span className="dv-item-title">{p.title || '(untitled)'}</span>
                <span className="dv-item-meta">
                  {p.date || 'no date'}
                  {!p.published && <span className="dv-tag">DRAFT</span>}
                </span>
              </button>
              <div className="dv-item-ord">
                <button type="button" disabled={i === 0 || busy}
                        title="Move up the page" onClick={() => reorder(p, -1)}>↑</button>
                <button type="button" disabled={i === ordered.length - 1 || busy}
                        title="Move down the page" onClick={() => reorder(p, 1)}>↓</button>
              </div>
            </div>
          ))}
        </aside>

        <section className="dv-edit">
          <div className="dv-row">
            <label className="dv-field dv-field--grow">
              <span>Title</span>
              <input value={draft.title ?? ''} onChange={e => set('title', e.target.value)} />
            </label>
            <label className="dv-field">
              <span>Date (free text)</span>
              <input value={draft.date ?? ''} placeholder="15 August 2026"
                     onChange={e => set('date', e.target.value)} />
            </label>
          </div>

          <label className="dv-field">
            <span>Slug — the #anchor people link to</span>
            <input value={draft.slug ?? ''} placeholder="rendezvous-and-routes"
                   onChange={e => set('slug', e.target.value)} />
          </label>

          <label className="dv-field">
            <span>Lede — one paragraph under the title</span>
            <textarea rows={2} value={draft.lede ?? ''}
                      onChange={e => set('lede', e.target.value)} />
          </label>

          <label className="dv-field">
            <span>
              Body — HTML. Allowed: h2, h3, p, ul, ol, li, strong, em, table.
              Anything else is stripped when it saves.
            </span>
            <textarea
              className="dv-html" rows={18} spellCheck
              value={draft.html ?? ''}
              onChange={e => set('html', e.target.value)}
            />
          </label>

          <div className="dv-row dv-row--toggles">
            <label className="dv-check">
              <input type="checkbox" checked={!!draft.published}
                     onChange={e => set('published', e.target.checked)} />
              <span>Published <em>— visible on the public page</em></span>
            </label>
            <label className="dv-check">
              <input type="checkbox" checked={!!draft.charts}
                     onChange={e => set('charts', e.target.checked)} />
              <span>Show combat charts <em>— under this post</em></span>
            </label>
          </div>

          <div className="dv-actions">
            <button type="button" className="dv-btn dv-btn--go" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : selected ? 'Save changes' : 'Create draft'}
            </button>
            {selected && (
              <button type="button" className="dv-btn dv-btn--danger" disabled={busy} onClick={remove}>
                Delete
              </button>
            )}
            {dirty && <span className="dv-dirty">unsaved changes</span>}
          </div>

          {/* THE PREVIEW. Raw HTML is only tolerable if you can see it
              rendered, in the page's own styles, while you type. */}
          <div className="dv-preview-head">Preview</div>
          <div className="cl">
            <div className="cl-hero dv-preview-hero">
              <div className="cl-eyebrow">— DEVLOG</div>
              <h1 className="cl-title">{draft.title || '(untitled)'}</h1>
              <div className="cl-date">{draft.date}</div>
              <div className="cl-lede">{draft.lede}</div>
            </div>
            <article
              className="cl-body"
              // Admin's own draft, rendered locally for them alone. The
              // stored copy is sanitised server-side before it can reach
              // any other reader.
              dangerouslySetInnerHTML={{ __html: draft.html ?? '' }}
            />
          </div>
        </section>
      </div>
    </div>
  );
};

export default DevlogAdmin;
