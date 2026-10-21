// ============================================================
// RoomFold — a card that is one summary line until it is opened.
//
// The room lobby keeps the things nobody needs on arrival (the rules, the
// Discord feed, the chat) folded to a single line that already says the
// useful part ("8 seats · 1-hour ticks · The Sol system", "Everything · tap to
// change", "2 new messages"). The header is a real <button aria-expanded>
// inside a heading, so it works from the keyboard and screen readers announce
// the state.
//
// The body stays MOUNTED while folded (just `hidden`): a half-typed chat line,
// a host's unsaved rule edit and the Discord feed's own fetch (which the
// summary reads) must not be thrown away by closing a card.
// ============================================================

import React, { useId } from 'react';
import { IconChevron } from './RoomParts';

export function RoomFold({
  icon, title, summary, open, onToggle, trailing, badge, children, className,
}: {
  icon: React.ReactNode;
  title: string;
  summary: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Visual-only word on the right of the row (e.g. "Edit"); it is part of the
   *  button's name, so keep it short. Replaces the chevron when given. */
  trailing?: React.ReactNode;
  /** A count in a dot (unread messages). */
  badge?: number;
  children: React.ReactNode;
  className?: string;
}) {
  const uid = useId();
  const headId = `rl-fold-h-${uid}`;
  const bodyId = `rl-fold-b-${uid}`;
  return (
    <section className={`rl-panel rl-fold ${open ? 'is-open' : ''} ${className ?? ''}`} aria-labelledby={headId}>
      <h2 className="rl-fold__h" id={headId}>
        <button
          type="button"
          className={`rl-fold__btn ${trailing ? 'has-tr' : ''}`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="rl-fold__ic" aria-hidden="true">{icon}</span>
          <span className="rl-fold__lab">
            <b>{title}</b>
            <span className="rl-fold__sum">{summary}</span>
          </span>
          {badge ? <span className="rl-fold__badge">{badge}</span> : null}
          {trailing ? <span className="rl-fold__tr">{trailing}</span> : null}
          <IconChevron className="rl-fold__chev" />
        </button>
      </h2>
      <div id={bodyId} className="rl-fold__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
