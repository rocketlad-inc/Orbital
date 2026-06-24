// ============================================================
// EditableName — click-to-edit inline text. Used for renaming
// ships, cities, and stations after creation.
//
// Behavior:
//   - Static label with a pencil affordance on hover.
//   - Click the label OR pencil to switch to an input.
//   - Enter / blur saves. Escape cancels (restores the old text).
//   - Empty / over-maxLength entries are rejected and we stay in
//     edit mode so the player can fix it.
//   - onSave is called with the trimmed new value. Callers wire it
//     to gameContext.renameShip / mpActions.renameShip and friends.
//
// The component is intentionally dumb about networking: the caller
// owns optimistic updates, server PATCHes, and error reporting.
// Failed saves can bring the user back to edit mode by re-throwing
// from onSave, or simply let the next /state poll restore the
// canonical value.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  /** Hard cap on length matches the server's validation (32). */
  maxLength?: number;
  /** Optional class for the static label span (e.g. faction color). */
  className?: string;
  /** Optional inline style for the static label. */
  style?: React.CSSProperties;
  /** Accessibility label for the affordance / input. */
  ariaLabel?: string;
  /** Disable editing entirely (e.g. ship is destroyed). */
  readOnly?: boolean;
}

export const EditableName: React.FC<Props> = ({
  value,
  onSave,
  maxLength = 32,
  className,
  style,
  ariaLabel,
  readOnly,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against blur firing on the same gesture that Enter handled.
  const submittingRef = useRef(false);

  // When the upstream value changes (e.g. /state poll) and we're not
  // mid-edit, keep the draft in sync so the next click-to-edit starts
  // from the canonical value.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Auto-select on enter so a tap-to-edit immediately lets the user
  // overwrite the whole name without manual selection.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const commit = async () => {
    if (submittingRef.current) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength) {
      // Keep the player in edit mode; the input border below turns
      // amber to flag the invalid length.
      return;
    }
    if (trimmed === value) {
      setEditing(false);
      return;
    }
    submittingRef.current = true;
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch {
      // Stay in edit mode so the user can retry or revise.
    } finally {
      submittingRef.current = false;
    }
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (readOnly) {
    return <span className={className} style={style}>{value}</span>;
  }

  if (!editing) {
    return (
      <span
        className={className}
        style={{ ...style, cursor: 'text' }}
        title={ariaLabel ?? 'Click to rename'}
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value}
        <span
          aria-hidden
          style={{
            marginLeft: 6,
            opacity: 0.45,
            fontSize: '0.85em',
            fontWeight: 'normal',
          }}
        >✎</span>
      </span>
    );
  }

  const tooLong = draft.length > maxLength;
  const empty = draft.trim().length === 0;
  const invalid = tooLong || empty;

  return (
    <input
      ref={inputRef}
      type="text"
      className={className}
      aria-label={ariaLabel ?? 'Rename'}
      maxLength={maxLength + 8} // soft slack so the user sees the over-length state
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (!submittingRef.current) commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      style={{
        ...style,
        background: 'rgba(10, 14, 20, 0.85)',
        border: `1px solid ${invalid ? '#ffb84d' : '#4ecdc4'}`,
        borderRadius: 3,
        color: invalid ? '#ffb84d' : 'inherit',
        padding: '2px 6px',
        font: 'inherit',
        minWidth: 80,
        outline: 'none',
      }}
    />
  );
};
