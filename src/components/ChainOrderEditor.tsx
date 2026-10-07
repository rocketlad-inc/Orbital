// ============================================================
// ChainOrderEditor
//
// Authoring half of CHAIN ORDERS: build an itinerary — go here, wait,
// go there — and hand it to whoever applies it.
//
// Deliberately NOT tied to a ship. The ship panel's chain is read off
// state that already exists (a committed plan is the truth, so it is
// rendered, not edited); this is for a group or a fleet, where the
// chain does not exist yet and every hull will solve it from its own
// orbit. One editor for both so the two action bars cannot drift into
// describing the same itinerary differently.
// ============================================================

import React from 'react';
import type { ChainStep } from '../physics/chainPlanner';
import { t, tn } from '../i18n/core';
import { tRich } from '../i18n/rich';
import { useI18n } from '../i18n/react';
import './ChainOrderEditor.css';

const WAIT_CHOICES = [1, 3, 6, 12, 24];

export const ChainOrderEditor: React.FC<{
  steps: ChainStep[];
  onChange: (next: ChainStep[]) => void;
  bodies: Array<{ id: string; name: string; ownedBy?: string | null }>;
  /** Rendered under the tape — used to say who the chain will apply to. */
  note?: string;
}> = ({ steps, onChange, bodies, note }) => {
  useI18n();
  const [dest, setDest] = React.useState('');
  const nameOf = (id: string) => bodies.find(b => b.id === id)?.name ?? t('site.chain.unknown');

  const sorted = React.useMemo(
    () => [...bodies].sort((a, b) => a.name.localeCompare(b.name)),
    [bodies],
  );

  const addLeg = (bodyId: string) => {
    if (!bodyId) return;
    onChange([...steps, { bodyId, wait: 0 }]);
    setDest('');
  };

  // A WAIT is a PROPERTY OF THE LEG IT PRECEDES, not a step of its
  // own -- same rule the ship panel uses, where a wait with nothing
  // after it is just a ship sitting still. So each row carries its own
  // hold chips rather than there being a separate "add wait" verb.

  const removeAt = (i: number) => onChange(steps.filter((_, k) => k !== i));

  return (
    <div className="chain-ed">
      {steps.length === 0 ? (
        <div className="chain-ed__empty">{t('site.chain.empty')}</div>
      ) : (
        <ol className="chain-ed__tape">
          {steps.map((st, i) => (
            <li key={`${st.bodyId}-${i}`} className="chain-ed__step">
              <span className="chain-ed__n">{i + 1}</span>
              <span className="chain-ed__b">
                {st.wait > 0 && (
                  <span className="chain-ed__wait">{t('site.chain.wait', { n: st.wait })}</span>
                )}
                {tRich('site.chain.goTo', { name: <em>{nameOf(st.bodyId)}</em> })}
              </span>
              <span className="chain-ed__waitpick">
                {WAIT_CHOICES.map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`chain-ed__wb${st.wait === n ? ' is-on' : ''}`}
                    title={tn('site.chain.hold', n)}
                    onClick={() => {
                      const next = steps.slice();
                      next[i] = { ...next[i], wait: next[i].wait === n ? 0 : n };
                      onChange(next);
                    }}
                  >{n}t</button>
                ))}
              </span>
              <button
                type="button"
                className="chain-ed__x"
                title={t('site.chain.dropTitle')}
                onClick={() => removeAt(i)}
              >✕</button>
            </li>
          ))}
        </ol>
      )}

      <div className="chain-ed__add">
        <select
          className="chain-ed__select"
          value={dest}
          onChange={(e) => { setDest(e.target.value); addLeg(e.target.value); }}
          title={t('site.chain.appendTitle')}
        >
          <option value="">{t('site.chain.addLeg')}</option>
          {sorted.map(b => (
            <option key={b.id} value={b.id}>
              {b.ownedBy === 'player' ? '★ ' : ''}{b.name}
            </option>
          ))}
        </select>
        {steps.length > 0 && (
          <button
            type="button"
            className="chain-ed__clear"
            onClick={() => onChange([])}
          >{t('site.chain.clear')}</button>
        )}
      </div>

      {note && <div className="chain-ed__note">{note}</div>}
    </div>
  );
};
