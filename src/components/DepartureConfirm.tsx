// ============================================================
// DepartureConfirm — the one-step "are you sure" before a group order
// strips a world of yours of every warship. Shared by the Fleet panel's
// bulk send and the map's group bar so the two ask the same question in
// the same words. See useDepartureCheck for when it appears.
// ============================================================

import React from 'react';
import { tn, t } from '../i18n/core';
import { useI18n } from '../i18n/react';
import type { DepartureWarning } from '../hooks/useDepartureCheck';
import './DepartureConfirm.css';

export const DepartureConfirm: React.FC<{
  warning: DepartureWarning;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ warning, onConfirm, onCancel }) => {
  useI18n();
  return (
    <div className="depart-confirm" role="alertdialog" aria-live="assertive">
      <div className="depart-confirm__warn">
        {tn('fleet.depart.bare', warning.worlds.length, { worlds: warning.worlds.join(', ') })}
      </div>
      {warning.etaTicks != null && (
        <div className="depart-confirm__eta">
          {tn('fleet.depart.eta', warning.etaTicks, { dest: warning.destName })}
        </div>
      )}
      <div className="depart-confirm__actions">
        <button type="button" className="depart-confirm__btn depart-confirm__btn--go" onClick={onConfirm}>
          {t('fleet.depart.send')}
        </button>
        <button type="button" className="depart-confirm__btn" onClick={onCancel} autoFocus>
          {t('fleet.depart.cancel')}
        </button>
      </div>
    </div>
  );
};
