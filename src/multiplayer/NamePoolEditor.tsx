// ============================================================
// NAME POOL EDITOR — the lobby control for "call my things what I say".
//
// Four lists: ships, captains, stations, cities. Names are handed out
// IN ORDER and the shipped generators take over when a list runs dry,
// so a partial list is a perfectly good answer — you are not signing
// up to name every hull you will ever build.
//
// Two ways in, because people arrive with their names in two shapes:
// typed one at a time, or already written down somewhere. The bulk box
// takes newlines OR commas, and the file picker reads any .txt/.csv
// into the same box rather than a second code path.
// ============================================================

import React, { useRef, useState } from 'react';
import {
  NAME_KINDS, NameKind, NamePools, EMPTY_POOLS, POOL_MAX,
  parseNameList, sanitizeNames,
} from '../game/namePools';
import './NamePoolEditor.css';

const LABEL: Record<NameKind, string> = {
  ship: 'Ships',
  captain: 'Captains',
  station: 'Stations',
  city: 'Cities',
};

const PLACEHOLDER: Record<NameKind, string> = {
  ship: 'Endeavour',
  captain: 'Ada Sørensen',
  station: 'High Anchor',
  city: 'New Lorneland',
};

export const NamePoolEditor: React.FC<{
  value: NamePools;
  onChange: (next: NamePools) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const [kind, setKind] = useState<NameKind>('ship');
  const [draft, setDraft] = useState('');
  const [bulk, setBulk] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pool = value[kind] ?? [];

  const commit = (next: string[]) => {
    onChange({ ...EMPTY_POOLS, ...value, [kind]: sanitizeNames(next) });
  };

  const addOne = () => {
    const name = draft.trim();
    if (!name) return;
    // sanitizeNames de-duplicates, so a repeat is silently a no-op —
    // say so rather than letting the box just clear itself.
    const before = pool.length;
    const next = sanitizeNames([...pool, name]);
    commit(next);
    setNote(next.length === before ? `"${name}" is already in the list` : null);
    setDraft('');
  };

  const addBulk = (text: string) => {
    const parsed = parseNameList(text);
    if (parsed.length === 0) { setNote('Nothing to add'); return; }
    const before = pool.length;
    const next = sanitizeNames([...pool, ...parsed]);
    commit(next);
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
            onClick={() => { setKind(k); setNote(null); }}
          >
            {LABEL[k]}
            {(value[k]?.length ?? 0) > 0 && (
              <span className="npe__tabn">{value[k].length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="npe__row">
        <input
          className="npe__input"
          value={draft}
          disabled={disabled}
          maxLength={32}
          placeholder={PLACEHOLDER[kind]}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } }}
          aria-label={`Add a ${kind} name`}
        />
        <button type="button" className="npe__btn" disabled={disabled || !draft.trim()} onClick={addOne}>
          Add
        </button>
        <button
          type="button"
          className="npe__btn"
          disabled={disabled}
          onClick={() => setBulkOpen(o => !o)}
          title="Paste a list, or load one from a file"
        >
          Bulk…
        </button>
      </div>

      {bulkOpen && (
        <div className="npe__bulk">
          <textarea
            className="npe__area"
            value={bulk}
            disabled={disabled}
            rows={5}
            placeholder={'One per line, or comma separated:\nEndeavour\nResolute, Kestrel'}
            onChange={e => setBulk(e.target.value)}
            aria-label="Paste names"
          />
          <div className="npe__row">
            <button type="button" className="npe__btn" disabled={disabled || !bulk.trim()}
                    onClick={() => addBulk(bulk)}>
              Add list
            </button>
            <button type="button" className="npe__btn" disabled={disabled}
                    onClick={() => fileRef.current?.click()}>
              Upload a file
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

      {note && <div className="npe__note">{note}</div>}

      {pool.length === 0 ? (
        <div className="npe__empty">
          No custom {LABEL[kind].toLowerCase()} — the game&rsquo;s own names are used.
        </div>
      ) : (
        <>
          <div className="npe__list">
            {pool.map((n, i) => (
              <span key={`${n}-${i}`} className="npe__chip">
                <span className="npe__chipn" title={n}>{n}</span>
                <button
                  type="button"
                  className="npe__x"
                  disabled={disabled}
                  aria-label={`Remove ${n}`}
                  onClick={() => commit(pool.filter((_, j) => j !== i))}
                >&#10005;</button>
              </span>
            ))}
          </div>
          <div className="npe__foot">
            <span>{pool.length} name{pool.length === 1 ? '' : 's'} · used in order</span>
            <button type="button" className="npe__clear" disabled={disabled}
                    onClick={() => commit([])}>
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
};
