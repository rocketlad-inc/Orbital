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
import './RuinsCard.css';

/** MIRRORS WRECK_SEIZE_COST in worker/actions.js: a colony ship's price. */
export const WRECK_SEIZE_COST = { ore: 80, credits: 60 } as const;

function buildingLabel(kind: string): string {
  return BUILDING_DEFS[kind as BuildingKind]?.displayName ?? kind;
}

export function RuinsCard({ bodyId }: { bodyId: string }) {
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
    id === 'player' ? 'yours' : (gameState.factions.find(f => f.id === id)?.name ?? 'unknown');

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
          ? 'Bring an armed ship here to take or raze these. Freighters and colony ships do not count.'
          : rivalForce > 0
            ? `Contested: ${rivalForce} rival warship${rivalForce === 1 ? '' : 's'} still here. Clear them off first.`
            : null;
        const seizeBlock = why ?? (deadWorld
          ? 'This world has no biosphere left; a city cannot stand on it.'
          : occupied
            ? `A ${w.type} already stands here. Only one per world.`
            : !canAfford
              ? `Rebuilding costs ${WRECK_SEIZE_COST.ore}M ${WRECK_SEIZE_COST.credits}C.`
              : null);
        return (
          <div className="ruins__item" key={w.id}>
            <div className="ruins__head">
              <span className="ruins__glyph">{w.type === 'city' ? '▦' : '◇'}</span>
              RUINS · {w.name}
              <span className="ruins__was">
                {w.formerOwner === 'player' ? 'your old ' : `${factionName(w.formerOwner)}'s `}{w.type}
              </span>
            </div>
            <div className="ruins__bld">
              {entries.length === 0
                ? 'No buildings survive.'
                : entries.map(([kind, lvl]) => {
                    const next = Number(lvl) - 1;
                    return (
                      <span key={kind} className="ruins__b">
                        {buildingLabel(kind)} {lvl}→{next > 0 ? next : <em>lost</em>}
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
                    title={`Rebuild it under your flag: every building a level down, 25% hull. `
                      + `${WRECK_SEIZE_COST.ore}M ${WRECK_SEIZE_COST.credits}C, no colony ship.`}
                  >
                    {w.formerOwner === 'player' ? 'Retake' : 'Seize'} · {WRECK_SEIZE_COST.ore}M {WRECK_SEIZE_COST.credits}C
                  </button>
                )}
                <button
                  className="ruins__raze"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Raze the ruins of ${w.name}? Nobody will be able to rebuild them.`)) return;
                    act(w.id, 'raze');
                  }}
                >
                  Raze
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
