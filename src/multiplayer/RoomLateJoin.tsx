// ============================================================
// RoomLateJoin — the world picker for someone who arrives after the match has
// started (an invite link opened late, no faction yet). Same fields and flow
// the lobby always had; only the page around it is the lobby's now.
// ============================================================

import React from 'react';
import { RoomPageShell } from './RoomLobbyScreen';
import { RESOURCE_LETTER_COLORS } from '../game/resourceColors';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

export type LateJoinBody = {
  id: string;
  name: string;
  type: string;
  yield: { metal: number; fuel: number; gold: number; science: number };
};

export function RoomLateJoin({
  roomName, bodies, empireName, onEmpireName, choice, onChoice, submitting, onSubmit, onBack, error, onDismissError,
}: {
  roomName: string;
  bodies: LateJoinBody[];
  empireName: string;
  onEmpireName: (v: string) => void;
  choice: string | null;
  onChoice: (id: string | null) => void;
  submitting: boolean;
  onSubmit: () => void;
  onBack: () => void;
  error: string | null;
  onDismissError: () => void;
}) {
  useI18n();
  return (
    <RoomPageShell
      title={roomName}
      sub={t('roomlobby.late.title')}
      onBack={onBack}
      menu={[]}
      error={error}
      onDismissError={onDismissError}
    >
      <div className="rl-layout rl-layout--one">
        <section className="rl-panel rl-sec rl-late">
          <h2 className="rl-h2">{t('roomlobby.late.title')}</h2>
          <p className="rl-hint">{t('roomlobby.late.desc')}</p>

          <div className="rl-fld">
            <label htmlFor="rl-late-empire">{t('roomlobby.late.empireName')}</label>
            <input
              id="rl-late-empire"
              className="rl-input"
              type="text"
              maxLength={40}
              value={empireName}
              onChange={(e) => onEmpireName(e.target.value)}
              placeholder={t('roomlobby.empirePlaceholder')}
            />
          </div>

          {bodies.length === 0 ? (
            <div className="rl-empty">{t('roomlobby.late.none')}</div>
          ) : (
            <>
              <h3 className="rl-ed__h">{t('roomlobby.late.worlds')}</h3>
              <div className="lobby-body-grid">
                {bodies.map((b) => {
                  const isMine = choice === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`lobby-body-card ${isMine ? 'is-mine' : ''}`}
                      aria-pressed={isMine}
                      onClick={() => onChoice(isMine ? null : b.id)}
                      title={isMine ? t('roomlobby.late.unpick') : t('roomlobby.claim')}
                    >
                      <div className="lobby-body-card__name">{b.name}</div>
                      <div className="lobby-body-card__sub">{b.type}</div>
                      <div className="lobby-body-card__yields">
                        {b.yield.metal > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.M }}>M{b.yield.metal}</span>}
                        {/* no F — fuel is dead (DESIGN-identity-economy.md §1.1) */}
                        {/* C = credits (server field is still 'gold') */}
                        {b.yield.gold > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.C }}>C{b.yield.gold}</span>}
                        {b.yield.science > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.S }}>S{b.yield.science}</span>}
                      </div>
                      {isMine && <div className="lobby-body-card__tag">{t('roomlobby.late.chosen')}</div>}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className="rl-row">
            <button
              type="button"
              className="rl-btn rl-btn--gold"
              disabled={!choice || submitting}
              onClick={onSubmit}
            >
              {submitting ? t('roomlobby.late.joining') : t('roomlobby.late.found')}
            </button>
            <button type="button" className="rl-btn rl-btn--quiet" onClick={onBack}>
              {t('roomlobby.back')}
            </button>
          </div>
        </section>
      </div>
    </RoomPageShell>
  );
}
