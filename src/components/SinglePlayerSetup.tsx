// ============================================================
// SinglePlayerSetup — pre-game configuration for SP campaigns.
// Replaces the old ScenarioSelector. Mirrors the multiplayer
// lobby's pre-game flow: pick your faction name + color +
// starting capital, configure 1-3 AI opponents, set match
// length, click Begin.
// ============================================================

import React, { useMemo, useState } from 'react';
import { Body, SinglePlayerConfig } from '../types';
import {
  getStartingBodyOptions,
  SP_FACTION_NAMES,
  SP_FACTION_COLORS,
  SP_MAX_AI_OPPONENTS,
} from '../state/singlePlayerSetup';
import { SaveLoadModal } from './SaveLoadModal';
import { listSaves } from '../state/saveGame';
import './SinglePlayerSetup.css';

interface Props {
  onBegin: (config: SinglePlayerConfig) => void;
  onCancel: () => void;
  /** Optional: surface a Load Save picker on this screen so the player
   *  can resume an existing campaign instead of configuring a new one. */
  onLoadSave?: (state: import('../types').GameState) => void;
}

interface FactionDraft {
  factionName: string;
  color: string;
  startingBodyId: string;
}

export const SinglePlayerSetup: React.FC<Props> = ({ onBegin, onCancel, onLoadSave }) => {
  const options = useMemo(() => getStartingBodyOptions(), []);
  // Read the save index once on mount so the "Load Save" button can
  // surface the count and stay hidden when there's nothing to load.
  const savedCount = useMemo(() => listSaves().length, []);
  const [loadModalOpen, setLoadModalOpen] = useState(false);

  // Default the player to Earth, AI #1 to Mars, AI #2 to Luna.
  const earthDefault = options.find(b => b.id === 'earth')?.id ?? options[0]?.id ?? '';
  const marsDefault = options.find(b => b.id === 'mars')?.id ?? options[1]?.id ?? '';

  const [player, setPlayer] = useState<FactionDraft>({
    factionName: 'Commander',
    color: '#4ecdc4',
    startingBodyId: earthDefault,
  });

  const [aiOpponents, setAiOpponents] = useState<FactionDraft[]>([
    {
      factionName: SP_FACTION_NAMES[1],
      color: SP_FACTION_COLORS[1],
      startingBodyId: marsDefault,
    },
  ]);

  // === Body picker logic ===

  // Returns a Set of bodyIds that are already claimed by some faction other
  // than the one currently being edited. Used to grey out "taken" cards.
  const claimedBy = useMemo(() => {
    const map = new Map<string, string>(); // bodyId → factionId
    map.set(player.startingBodyId, 'player');
    aiOpponents.forEach((ai, i) => {
      if (ai.startingBodyId) map.set(ai.startingBodyId, `ai-${i + 1}`);
    });
    return map;
  }, [player, aiOpponents]);

  function setPlayerBody(bodyId: string) {
    setPlayer(p => ({ ...p, startingBodyId: bodyId }));
  }

  function setAiBody(index: number, bodyId: string) {
    setAiOpponents(prev => prev.map((ai, i) =>
      i === index ? { ...ai, startingBodyId: bodyId } : ai,
    ));
  }

  function updateAi(index: number, patch: Partial<FactionDraft>) {
    setAiOpponents(prev => prev.map((ai, i) =>
      i === index ? { ...ai, ...patch } : ai,
    ));
  }

  function addAi() {
    if (aiOpponents.length >= SP_MAX_AI_OPPONENTS) return;
    // Pick a faction name/color slot that isn't in use yet.
    const taken = new Set([player.factionName, ...aiOpponents.map(a => a.factionName)]);
    const nextName = SP_FACTION_NAMES.find(n => !taken.has(n)) ?? SP_FACTION_NAMES[aiOpponents.length + 1];
    const nextColor = SP_FACTION_COLORS[(aiOpponents.length + 1) % SP_FACTION_COLORS.length];

    // Pick the first unclaimed body
    const claimedNow = new Set(claimedBy.keys());
    const nextBody = options.find(b => !claimedNow.has(b.id))?.id ?? options[0].id;

    setAiOpponents(prev => [
      ...prev,
      { factionName: nextName, color: nextColor, startingBodyId: nextBody },
    ]);
  }

  function removeAi(index: number) {
    setAiOpponents(prev => prev.filter((_, i) => i !== index));
  }

  const handleBegin = () => {
    const config: SinglePlayerConfig = {
      player,
      aiOpponents,
    };
    onBegin(config);
  };

  // === Validation ===

  const playerBodyTaken = !!claimedBy.get(player.startingBodyId)
    && claimedBy.get(player.startingBodyId) !== 'player';
  const anyAiBodyConflict = aiOpponents.some((ai, i) => {
    const c = claimedBy.get(ai.startingBodyId);
    return c && c !== `ai-${i + 1}`;
  });
  const hasNameCollision = (() => {
    const names = [player.factionName.trim().toLowerCase(), ...aiOpponents.map(a => a.factionName.trim().toLowerCase())];
    return new Set(names).size !== names.length;
  })();
  const validationError = playerBodyTaken
    ? 'Your starting body is claimed by another faction.'
    : anyAiBodyConflict
      ? 'Two factions claim the same body.'
      : hasNameCollision
        ? 'Two factions share a name. Make each unique.'
        : null;

  return (
    <div className="sp-setup">
      <header className="sp-setup-nav">
        <button className="sp-setup-back" onClick={onCancel}>← BACK</button>
        <div className="sp-setup-brand">
          <span className="brand-glyph">◉</span>
          <span className="brand-text">ORBITAL · NEW CAMPAIGN</span>
        </div>
        {onLoadSave && savedCount > 0 ? (
          <button
            onClick={() => setLoadModalOpen(true)}
            title="Resume a saved campaign"
            style={{
              minWidth: 90,
              padding: '6px 14px',
              background: 'transparent',
              border: '1px solid #4ecdc4',
              color: '#4ecdc4',
              borderRadius: 4,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              cursor: 'pointer',
            }}
          >
            ⤒ LOAD SAVE ({savedCount})
          </button>
        ) : (
          <div style={{ width: 90 }} />
        )}
      </header>

      {loadModalOpen && onLoadSave && (
        <SaveLoadModal
          mode="load"
          onClose={() => setLoadModalOpen(false)}
          onLoad={(state) => {
            setLoadModalOpen(false);
            onLoadSave(state);
          }}
        />
      )}

      <div className="sp-setup-intro">
        <h1>New Single-Player Campaign</h1>
        <p>
          Configure your faction and the AI opponents you'll face. Each faction
          spawns with a capital, a starter station + city, and a small fleet.
          Games run as long as you keep playing — there's no tick countdown.
        </p>
      </div>

      {/* === Player faction === */}
      <section className="sp-setup-section">
        <div className="sp-setup-section-head">
          <div className="sp-setup-eyebrow">01 · YOU</div>
          <h2>Your faction</h2>
        </div>
        <div className="sp-faction-card sp-faction-card--player">
          <FactionEditor
            draft={player}
            onChange={patch => setPlayer(p => ({ ...p, ...patch }))}
            isPlayer
          />
          <div className="sp-body-picker-title">Starting capital</div>
          <BodyGrid
            options={options}
            selectedId={player.startingBodyId}
            claimedBy={claimedBy}
            myKey="player"
            onPick={setPlayerBody}
            color={player.color}
          />
        </div>
      </section>

      {/* === AI opponents === */}
      <section className="sp-setup-section">
        <div className="sp-setup-section-head">
          <div className="sp-setup-eyebrow">02 · ENEMIES</div>
          <h2>AI opponents ({aiOpponents.length})</h2>
          <p className="sp-setup-section-desc">
            Each AI runs the same brain — utility-driven, decision cycle
            every 50 ticks, with build / deploy / transfer / research
            behaviors. Watch them play via the AI ACTIVITY widget once
            the campaign starts.
          </p>
        </div>

        {aiOpponents.map((ai, i) => (
          <div key={i} className="sp-faction-card sp-faction-card--ai">
            <div className="sp-ai-head">
              <span className="sp-ai-tag">AI #{i + 1}</span>
              {aiOpponents.length > 1 && (
                <button
                  className="sp-ai-remove"
                  onClick={() => removeAi(i)}
                  title="Remove this AI"
                >× REMOVE</button>
              )}
            </div>
            <FactionEditor
              draft={ai}
              onChange={patch => updateAi(i, patch)}
              isPlayer={false}
            />
            <div className="sp-body-picker-title">Starting capital</div>
            <BodyGrid
              options={options}
              selectedId={ai.startingBodyId}
              claimedBy={claimedBy}
              myKey={`ai-${i + 1}`}
              onPick={id => setAiBody(i, id)}
              color={ai.color}
            />
          </div>
        ))}

        {aiOpponents.length < SP_MAX_AI_OPPONENTS && (
          <button className="sp-add-ai" onClick={addAi}>
            + ADD AI OPPONENT
          </button>
        )}
      </section>

      {/* === Begin === */}
      <footer className="sp-setup-foot">
        {validationError && (
          <div className="sp-setup-error">{validationError}</div>
        )}
        <button
          className="sp-begin"
          disabled={!!validationError}
          onClick={handleBegin}
        >
          ▶ BEGIN CAMPAIGN
        </button>
        <div className="sp-begin-sub">
          {1 + aiOpponents.length} factions
        </div>
      </footer>
    </div>
  );
};

// ============================================================
// FactionEditor — name + color row
// ============================================================

const FactionEditor: React.FC<{
  draft: FactionDraft;
  onChange: (patch: Partial<FactionDraft>) => void;
  isPlayer: boolean;
}> = ({ draft, onChange, isPlayer }) => (
  <div className="sp-faction-editor">
    <div className="sp-field">
      <label>FACTION NAME</label>
      <input
        type="text"
        value={draft.factionName}
        maxLength={32}
        onChange={e => onChange({ factionName: e.target.value })}
        placeholder={isPlayer ? 'Commander' : 'Hostile Power'}
      />
    </div>
    <div className="sp-field sp-field--color">
      <label>COLOR</label>
      <div className="sp-color-row">
        {SP_FACTION_COLORS.map(c => (
          <button
            key={c}
            className={`sp-color-swatch ${draft.color === c ? 'active' : ''}`}
            style={{ background: c }}
            onClick={() => onChange({ color: c })}
            title={c}
          />
        ))}
      </div>
    </div>
  </div>
);

// ============================================================
// BodyGrid — pick a starting capital
// ============================================================

const BodyGrid: React.FC<{
  options: Body[];
  selectedId: string;
  claimedBy: Map<string, string>;
  myKey: string;
  onPick: (id: string) => void;
  color: string;
}> = ({ options, selectedId, claimedBy, myKey, onPick, color }) => (
  <div className="sp-body-grid">
    {options.map(opt => {
      const owner = claimedBy.get(opt.id);
      const isMine = owner === myKey;
      const isTaken = !!owner && !isMine;
      const yields = opt.resources;
      return (
        <button
          key={opt.id}
          className={`sp-body-card ${isMine ? 'is-mine' : ''} ${isTaken ? 'is-taken' : ''}`}
          disabled={isTaken}
          onClick={() => onPick(opt.id)}
          style={isMine ? { borderColor: color, boxShadow: `0 0 12px ${color}40` } : undefined}
        >
          <div className="sp-body-card-name">{opt.name}</div>
          <div className="sp-body-card-type">
            {opt.type}{opt.parent && opt.parent !== 'sol' ? ` · ${opt.parent}` : ''}
          </div>
          {yields && (
            <div className="sp-body-card-yields">
              {yields.metal > 0 && <span className="y-m">M{yields.metal}</span>}
              {yields.fuel > 0 && <span className="y-f">F{yields.fuel}</span>}
              {yields.gold > 0 && <span className="y-g">G{yields.gold}</span>}
              {yields.science > 0 && <span className="y-s">S{yields.science}</span>}
            </div>
          )}
          {isMine && <div className="sp-body-card-tag" style={{ color }}>✓ CLAIMED</div>}
          {isTaken && <div className="sp-body-card-tag is-taken">TAKEN</div>}
        </button>
      );
    })}
  </div>
);
