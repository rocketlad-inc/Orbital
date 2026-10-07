// ============================================================================
// RuinsCard -- the ruins on a world, and what you can do with them (0142).
//
// A settlement beaten down by warships leaves ruins. The only faction with
// warships at the world can SEIZE them -- a colony ship's price, no colony
// ship, every building one level lower, 25% hull -- or RAZE them. The same
// button retakes your own lost world and takes a rival's.
//
// Mirrors handleWreck (worker/actions.js): an armed hull of yours parked
// here and nobody else's. Fog of war can hide a rival warship, so the
// server keeps the last word; this only stops the hopeless click and says
// what is missing.
// ============================================================================

import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from './MultiplayerActionsContext';
import { humanizeMpError } from './errorMessages';
import { BUILDING_DEFS } from '../game/settlements';
import type { BuildingKind } from '../types';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './RuinsCard.css';

/** MIRRORS WRECK_SEIZE_COST in worker/actions.js: a colony ship's price. */
export const WRECK_SEIZE_COST = { ore: 80, credits: 60 } as const;

/** "city" / "station" as a word a player reads (w.type is a code). */
function typeWord(type: string): string {
  return type === 'city' ? t('mp.ruins.type.city') : t('mp.ruins.type.station');
}

function buildingLabel(kind: string): string {
  return BUILDING_DEFS[kind as BuildingKind]?.displayName ?? kind;
}

export function RuinsCard({ bodyId }: { bodyId: string }) {
  useI18n();
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrecks = (gameState.wrecks ?? []).filter(w => w.bodyId === bodyId);
  if (wrecks.length === 0 || !mpActions) return null;

  const body = gameState.bodies.find(b => b.id === bodyId);
  const armedHere = gameState.ships.filter(sh =>
    sh.orbit?.parentBodyId === bodyId && !sh.transit
    && sh.class !== 'freighter' && sh.class !== 'colony');
  const myForce = armedHere.filter(sh => sh.ownedBy === 'player').length;
  const rivalForce = armedHere.filter(sh => sh.ownedBy !== 'player').length;
  const standing = new Set(gameState.settlements.filter(s => s.bodyId === bodyId).map(s => s.type));
  const purse = gameState.resources['player'];
  const canAfford = !!purse && purse.ore >= WRECK_SEIZE_COST.ore && purse.credits >= WRECK_SEIZE_COST.credits;
  const factionName = (id: string | null) =>
    id === 'player' ? t('mp.ruins.yours') : (gameState.factions.find(f => f.id === id)?.name ?? t('mp.ruins.unknown'));

  const act = (id: string, mode: 'seize' | 'raze') => {
    setBusy(true); setError(null);
    mpActions.wreckAction(id, mode).then((res) => {
      setBusy(false);
      if (!res.ok) setError(humanizeMpError(res.code, res.error, 'transfer'));
    });
  };

  return (
    <div className="ruins">
      {wrecks.map((w) => {
        const entries = Object.entries(w.buildings).filter(([, lvl]) => Number(lvl) > 0);
        // WHAT IS MISSING, ONE THING AT A TIME, in the order a player
        // works through it: get there, clear it, and the price.
        const deadWorld = w.type === 'city' && body?.terraformedAtTick === null;
        const occupied = standing.has(w.type);
        const why = myForce === 0
          ? t('mp.ruins.needArmed')
          : rivalForce > 0
            ? tn('mp.ruins.contested', rivalForce)
            : null;
        const seizeBlock = why ?? (deadWorld
          ? t('mp.ruins.noBiosphere')
          : occupied
            ? t('mp.ruins.occupied', { type: typeWord(w.type) })
            : !canAfford
              ? t('mp.ruins.cost', { ore: WRECK_SEIZE_COST.ore, credits: WRECK_SEIZE_COST.credits })
              : null);
        return (
          <div className="ruins__item" key={w.id}>
            <div className="ruins__head">
              <span className="ruins__glyph">{w.type === 'city' ? '▦' : '◇'}</span>
              {t('mp.ruins.title', { name: w.name })}
              <span className="ruins__was">
                {w.formerOwner === 'player'
                  ? t('mp.ruins.wasYours', { type: typeWord(w.type) })
                  : t('mp.ruins.wasTheirs', { name: factionName(w.formerOwner), type: typeWord(w.type) })}
              </span>
            </div>
            <div className="ruins__bld">
              {entries.length === 0
                ? t('mp.ruins.none')
                : entries.map(([kind, lvl]) => {
                    const next = Number(lvl) - 1;
                    return (
                      <span key={kind} className="ruins__b">
                        {buildingLabel(kind)} {lvl}→{next > 0 ? next : <em>{t('mp.ruins.lost')}</em>}
                      </span>
                    );
                  })}
            </div>
            {seizeBlock && <div className="ruins__hint">{seizeBlock}</div>}
            {!why && (
              <div className="ruins__btns">
                {!seizeBlock && (
                  <button
                    className="ruins__take"
                    disabled={busy}
                    onClick={() => act(w.id, 'seize')}
                    title={t('mp.ruins.seizeTitle', { ore: WRECK_SEIZE_COST.ore, credits: WRECK_SEIZE_COST.credits })}
                  >
                    {t(w.formerOwner === 'player' ? 'mp.ruins.retake' : 'mp.ruins.seize', { ore: WRECK_SEIZE_COST.ore, credits: WRECK_SEIZE_COST.credits })}
                  </button>
                )}
                <button
                  className="ruins__raze"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(t('mp.ruins.confirmRaze', { name: w.name }))) return;
                    act(w.id, 'raze');
                  }}
                >
                  {t('mp.ruins.raze')}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="ruins__err">{error}</div>}
    </div>
  );
}
