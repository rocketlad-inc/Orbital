// ============================================================
// AdminLinkGenerator — make a tagged link for a post (admin).
//
// Every post gets its own orbital-empire.com/?from=<tag> link, and the
// traffic table and chart below group visits and signups by that tag.
// Pick where it is going, name the place, copy the link. The tag follows
// the habit the existing ones set: r-space for a subreddit,
// discord-stellaris for a Discord server. A tag that already has visits
// says so, so a new post can share its link or take a new one on
// purpose. The tag rules mirror cleanTag() in worker/attribution.js:
// lowercase letters, digits, dot, dash, underscore, at most 40.
// ============================================================

import React, { useMemo, useState } from 'react';
import './AdminLinkGenerator.css';

const SITE = 'https://orbital-empire.com';

const PLACES = [
  { key: 'reddit', label: 'Reddit', prefix: 'r-', ask: 'Subreddit', example: 'spacegames' },
  { key: 'discord', label: 'Discord', prefix: 'discord-', ask: 'Server', example: 'stellaris' },
  { key: 'bluesky', label: 'Bluesky', prefix: 'bsky-', ask: 'Account or post', example: 'devlog' },
  { key: 'x', label: 'X', prefix: 'x-', ask: 'Account or post', example: 'devlog' },
  { key: 'other', label: 'Other', prefix: '', ask: 'Tag', example: 'newsletter' },
] as const;
type PlaceKey = typeof PLACES[number]['key'];

/** The same cut the server makes (worker/attribution.js cleanTag). */
export function cleanTag(v: string, max = 40): string {
  return v.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
}

/** The finished link, or null with nothing to tag. */
export function buildLink(tag: string, campaign: string): string | null {
  if (!tag) return null;
  const c = cleanTag(campaign, 60);
  return `${SITE}/?from=${encodeURIComponent(tag)}${c ? `&utm_campaign=${encodeURIComponent(c)}` : ''}`;
}

export function LinkGenerator({ seen }: { seen: Record<string, number> }) {
  const [place, setPlace] = useState<PlaceKey>('discord');
  const [name, setName] = useState('');
  const [campaign, setCampaign] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const spec = PLACES.find(p => p.key === place)!;

  // "r/Space" and "r-space" are the same subreddit: drop a typed prefix.
  const tag = useMemo(() => {
    let t = cleanTag(name);
    const bare = spec.prefix.replace(/-$/, '');
    if (bare && (t.startsWith(`${bare}-`) || t === bare)) t = t.slice(bare.length).replace(/^-+/, '');
    return t ? cleanTag(`${spec.prefix}${t}`) : '';
  }, [name, spec]);
  const link = buildLink(tag, campaign);
  const visits = tag ? seen[tag] : undefined;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(c => (c === text ? null : c)), 1800); }
    catch { /* the link is selectable in the box */ }
  };

  const used = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="lg">
      <div className="lg-head">
        <h4 className="lg-title">Link generator</h4>
        <span className="lg-sub">One link per post, so its visits and signups read as their own line.</span>
      </div>
      <div className="lg-row">
        <div className="lg-seg" role="radiogroup" aria-label="Where the link goes">
          {PLACES.map(p => (
            <button key={p.key} type="button" role="radio" aria-checked={place === p.key}
              className={place === p.key ? 'is-on' : ''} onClick={() => setPlace(p.key)}>{p.label}</button>
          ))}
        </div>
        <label className="lg-field">
          <span>{spec.ask}</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={spec.example} maxLength={40}
            spellCheck={false} autoCapitalize="off" aria-label={spec.ask} />
        </label>
        <label className="lg-field">
          <span>Campaign <i>(optional)</i></span>
          <input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="launch-week" maxLength={60}
            spellCheck={false} autoCapitalize="off" aria-label="Campaign" />
        </label>
      </div>
      {link ? (
        <div className="lg-out">
          <input className="lg-url" readOnly value={link} onFocus={e => e.currentTarget.select()} aria-label="Your link" />
          <button type="button" className="lg-copy" onClick={() => copy(link)}>{copied === link ? 'Copied' : 'Copy link'}</button>
        </div>
      ) : <p className="lg-hint">Name the place and the link appears.</p>}
      {link && (
        <p className="lg-hint">
          Shows up as <b>{tag}</b>
          {visits ? <> · already {visits.toLocaleString()} visit{visits === 1 ? '' : 's'} in the last 30 days, so this reuses an existing line.</> : ' · no visits yet, so it starts a new line.'}
        </p>
      )}
      {used.length > 0 && (
        <div className="lg-used" aria-label="Tags in use">
          <span className="lg-used__label">In use:</span>
          {used.map(([t, v]) => (
            <button key={t} type="button" className="lg-tag" title="Copy this tag's link"
              onClick={() => copy(buildLink(t, '')!)}>
              {copied === buildLink(t, '') ? 'Copied' : t}<span>{v.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
