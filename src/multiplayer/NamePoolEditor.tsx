// ============================================================
// NAME POOL EDITOR — the lobby control for "call my things what I say".
//
// Four lists: ships, captains, stations, cities. Names are handed out
// IN ORDER and the shipped generators take over when a list runs dry,
// so a partial list is a perfectly good answer — you are not signing
// up to name every hull you will ever build.
//
// A DRAFT, THEN A SAVE. The first cut wrote to the server on every
// keystroke, which is fine for a toggle and wrong for a list you build
// up over minutes: there was no moment where you knew it had taken,
// and no way to change your mind. Edits are local until you save, the
// footer says whether anything is pending, and Revert throws the draft
// away.
//
// Two ways in, because people arrive with their names in two shapes:
// typed one at a time, or already written down somewhere. The bulk box
// takes newlines OR commas, and the file picker feeds that same box
// rather than a second code path.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  NAME_KINDS, NameKind, NamePools, EMPTY_POOLS, POOL_MAX,
  parseNameList, sanitizeNames, adoptServerPools,
} from '../game/namePools';
import './NamePoolEditor.css';

const LABEL: Record<NameKind, string> = {
  ship: 'Ships', captain: 'Captains', station: 'Stations', city: 'Cities',
};
const ONE: Record<NameKind, string> = {
  ship: 'ship', captain: 'captain', station: 'station', city: 'city',
};
const PLACEHOLDER: Record<NameKind, string> = {
  ship: 'Endeavour', captain: 'Ada Sørensen', station: 'High Anchor', city: 'New Lorneland',
};

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const NamePoolEditor: React.FC<{
  value: NamePools;
  onSave: (next: NamePools) => Promise<void> | void;
  disabled?: boolean;
}> = ({ value, onSave, disabled }) => {
  const [kind, setKind] = useState<NameKind>('ship');
  const [draft, setDraft] = useState<NamePools>(value);
  const [entry, setEntry] = useState('');
  const [bulk, setBulk] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = useMemo(
    () => NAME_KINDS.some(k => !sameList(draft[k] ?? [], value[k] ?? [])),
    [draft, value],
  );

  // Adopt server state only when there is nothing of the player's to
  // lose -- measured against the snapshot we LAST synced to, not the
  // one that just arrived.
  //
  // This used to read `if (!dirty) setDraft(value)`, and dirty is
  // draft-vs-CURRENT-value, so the snapshot carrying the saved names
  // made the editor dirty in the same render and the adopt refused to
  // fire. Reloading the lobby showed four empty tabs, all flagged
  // unsaved, over a row holding 249 names -- and a Save from that state
  // would have written the empty draft back over them.
  const lastServerRef = useRef<NamePools>(value);
  useEffect(() => {
    setDraft(d => adoptServerPools(d, lastServerRef.current, value));
    lastServerRef.current = value;
  }, [value]);

  const pool = draft[kind] ?? [];
  const dirtyKinds = NAME_KINDS.filter(k => !sameList(draft[k] ?? [], value[k] ?? []));

  const setPool = (next: string[]) =>
    setDraft(d => ({ ...EMPTY_POOLS, ...d, [kind]: sanitizeNames(next) }));

  const addOne = () => {
    const name = entry.trim();
    if (!name) return;
    const before = pool.length;
    const next = sanitizeNames([...pool, name]);
    setPool(next);
    // Silent de-duplication looks like a broken box. Say so.
    setNote(next.length === before ? `“${name}” is already in this list` : null);
    setEntry('');
  };

  const addBulk = (text: string) => {
    const parsed = parseNameList(text);
    if (parsed.length === 0) { setNote('Nothing to add'); return; }
    const before = pool.length;
    const next = sanitizeNames([...pool, ...parsed]);
    setPool(next);
    const added = next.length - before;
    const skipped = parsed.length - added;
    setNote(
      `Added ${added}`
      + (skipped > 0 ? ` · skipped ${skipped} already listed` : '')
      + (next.length >= POOL_MAX ? ` · list is full at ${POOL_MAX}` : ''),
    );
    setBulk('');
    setBulkOpen(false);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addBulk(String(reader.result ?? ''));
    reader.onerror = () => setNote('Could not read that file');
    reader.readAsText(file);
  };

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      await onSave(draft);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      // The draft is deliberately kept. A failed save that also threw
      // the work away would be worse than no save button at all.
      setNote(e instanceof Error && e.message ? e.message : 'Could not save — your list is still here');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="npe">
      <div className="npe__tabs" role="tablist">
        {NAME_KINDS.map(k => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={`npe__tab${kind === k ? ' is-on' : ''}`}
            onClick={() => { setKind(k); setNote(null); setBulkOpen(false); }}
          >
            {LABEL[k]}
            <span className="npe__tabn">{draft[k]?.length ?? 0}</span>
            {/* A dot on a tab you are not looking at is the only way to
                know an edit over there is still unsaved. */}
            {dirtyKinds.includes(k) && <span className="npe__dot" aria-label="unsaved" />}
          </button>
        ))}
      </div>

      <div className="npe__row">
        <input
          className="npe__input"
          value={entry}
          disabled={disabled}
          maxLength={32}
          placeholder={`Add a ${ONE[kind]} name — e.g. ${PLACEHOLDER[kind]}`}
          onChange={e => setEntry(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } }}
          aria-label={`Add a ${ONE[kind]} name`}
        />
        <button type="button" className="npe__btn is-primary"
                disabled={disabled || !entry.trim()} onClick={addOne}>
          Add
        </button>
        <button
          type="button"
          className={`npe__btn${bulkOpen ? ' is-on' : ''}`}
          disabled={disabled}
          aria-expanded={bulkOpen}
          onClick={() => setBulkOpen(o => !o)}
          title="Paste a list, or load one from a file"
        >
          Paste a list
        </button>
      </div>

      {bulkOpen && (
        <div className="npe__bulk">
          <textarea
            className="npe__area"
            value={bulk}
            disabled={disabled}
            rows={4}
            placeholder={'One per line, or comma separated\nEndeavour\nResolute, Kestrel'}
            onChange={e => setBulk(e.target.value)}
            aria-label="Paste names"
          />
          <div className="npe__row">
            <button type="button" className="npe__btn is-primary"
                    disabled={disabled || !bulk.trim()} onClick={() => addBulk(bulk)}>
              Add {parseNameList(bulk).length || ''} name{parseNameList(bulk).length === 1 ? '' : 's'}
            </button>
            <button type="button" className="npe__btn" disabled={disabled}
                    onClick={() => fileRef.current?.click()}>
              Upload .txt / .csv
            </button>
            <button type="button" className="npe__link" onClick={() => { setBulk(''); setBulkOpen(false); }}>
              Cancel
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              className="npe__file"
              onChange={e => { onFile(e.target.files?.[0]); e.currentTarget.value = ''; }}
            />
          </div>
        </div>
      )}

      <div className="npe__list">
        {pool.length === 0 ? (
          <span className="npe__empty">
            No custom {LABEL[kind].toLowerCase()} yet — the game&rsquo;s own names are used.
          </span>
        ) : pool.map((n, i) => (
          <span key={`${n}-${i}`} className="npe__chip">
            <span className="npe__chipi">{i + 1}</span>
            <span className="npe__chipn" title={n}>{n}</span>
            <button
              type="button"
              className="npe__x"
              disabled={disabled}
              aria-label={`Remove ${n}`}
              onClick={() => setPool(pool.filter((_, j) => j !== i))}
            >&#10005;</button>
          </span>
        ))}
      </div>

      {note && <div className="npe__note">{note}</div>}

      <div className="npe__foot">
        <span className="npe__status">
          {savedFlash
            ? <span className="npe__ok">✓ Saved</span>
            : dirty
              ? `Unsaved changes in ${dirtyKinds.map(k => LABEL[k].toLowerCase()).join(', ')}`
              : 'All changes saved'}
        </span>
        {pool.length > 0 && (
          <button type="button" className="npe__link" disabled={disabled}
                  onClick={() => setPool([])}>
            Clear {LABEL[kind].toLowerCase()}
          </button>
        )}
        {dirty && (
          <button type="button" className="npe__link" disabled={disabled || saving}
                  onClick={() => { setDraft(value); setNote(null); }}>
            Revert
          </button>
        )}
        <button
          type="button"
          className="npe__save"
          disabled={disabled || !dirty || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save names'}
        </button>
      </div>
    </div>
  );
};
