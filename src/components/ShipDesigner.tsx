// ============================================================
// ShipDesigner — multiplayer-only design library + loadout editor.
// DESIGN-identity-economy.md §2.
//
// Reachable from the Fleet panel button and the BuildPanel quick-link
// (both dispatch the 'orbital:open-ship-designer' window event; GameUI
// mounts this overlay in response — MP only).
//
// Data flow: the design library arrives on every /state poll
// (gameState.shipDesigns). Mutations post through mpActions and then
// refresh via GET /designs so the UI doesn't wait ~1.5s for the next
// poll. The server is authoritative on validation (slots, part
// compatibility, one-active-per-class).
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions, ServerShipDesign } from '../multiplayer/MultiplayerActionsContext';
import { ShipClassName, SHIP_CLASSES, BUILDABLE_CLASSES } from '../game/shipClasses';
import {
  ShipPartId, ALL_PART_IDS, SHIP_PART_DEFS, SHIP_SLOT_COUNTS,
  sanitizeParts, computeDesignStats, partsCost, countPart,
  detonatorDamage, detonatorDisclosure, SERVER_HULL_BASE,
} from '../game/shipParts';
import {
  ShipIcon, ShipIconVariant, ALL_VARIANTS, ICON_VARIANT_NAMES, DEFAULT_SHIP_ICONS,
} from './ShipIcons';
import type { ShipDesign } from '../types';
import './ShipDesigner.css';

interface ShipDesignerProps {
  /** Class tab to open on (the BuildPanel quick-link passes the row's
   *  class). Defaults to corvette. */
  initialClass?: ShipClassName;
  onClose: () => void;
}

/** Map a server design row to the client shape (mirrors the
 *  MultiplayerGameProvider deserializer). */
function serverDesignToClient(d: ServerShipDesign): ShipDesign {
  let parts: string[] = [];
  if (d.parts_json) {
    try { parts = sanitizeParts(JSON.parse(d.parts_json)); } catch { /* bare hull */ }
  }
  let iv: ShipDesign['iconVariant'];
  if (d.icon_variant && /^[A-F]$/.test(d.icon_variant)) {
    iv = d.icon_variant as ShipDesign['iconVariant'];
  }
  return {
    id: d.id,
    shipClass: (BUILDABLE_CLASSES.includes(d.ship_class as ShipClassName)
      ? d.ship_class
      : 'frigate') as ShipDesign['shipClass'],
    name: d.name,
    parts,
    iconVariant: iv,
    isActive: d.is_active === true,
    createdAtMs: d.created_at_ms,
  };
}

const PART_GLYPH: Record<ShipPartId, string> = {
  weapon: '⚔',
  shield: '🛡',
  engine: '🔥',
  detonator: '☠',
};

export const ShipDesigner: React.FC<ShipDesignerProps> = ({ initialClass, onClose }) => {
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();

  const [activeClass, setActiveClass] = useState<ShipClassName>(initialClass ?? 'corvette');
  // Fresh server copy after a mutation; null = use the /state mirror.
  const [freshDesigns, setFreshDesigns] = useState<ShipDesign[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftParts, setDraftParts] = useState<ShipPartId[]>([]);
  const [draftIcon, setDraftIcon] = useState<ShipIconVariant | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stateDesigns = gameState.shipDesigns;
  const classDesigns = useMemo(() => {
    const all = freshDesigns ?? stateDesigns ?? [];
    return all.filter(d => d.shipClass === activeClass);
  }, [freshDesigns, stateDesigns, activeClass]);
  const selected = classDesigns.find(d => d.id === selectedId) ?? null;

  const techLevels = gameState.factionTech['player']?.levels ?? {};
  const slots = SHIP_SLOT_COUNTS[activeClass];
  const hullDef = SHIP_CLASSES[activeClass];
  const stats = computeDesignStats(activeClass, draftParts, techLevels);
  const bare = computeDesignStats(activeClass, [], {});
  const draftCost = partsCost(draftParts);
  const nDetonators = countPart(draftParts, 'detonator');
  const detDamage = detonatorDamage(stats.hp, nDetonators, techLevels.weapons ?? 0);

  const refresh = async () => {
    if (!mpActions) return;
    const rows = await mpActions.getDesigns();
    if (rows) setFreshDesigns(rows.map(serverDesignToClient));
  };

  const loadDesign = (d: ShipDesign | null) => {
    setSelectedId(d?.id ?? null);
    setDraftName(d?.name ?? '');
    setDraftParts(d ? sanitizeParts(d.parts) : []);
    setDraftIcon(d?.iconVariant);
    setError(null);
  };

  const switchClass = (cls: ShipClassName) => {
    setActiveClass(cls);
    setSelectedId(null);
    setDraftName('');
    setDraftParts([]);
    setDraftIcon(undefined);
    setError(null);
  };

  const addPart = (id: ShipPartId) => {
    if (draftParts.length >= slots) return;
    setDraftParts(prev => [...prev, id]);
  };
  const removePart = (id: ShipPartId) => {
    setDraftParts(prev => {
      const idx = prev.lastIndexOf(id);
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
  };

  const save = async (setActive: boolean) => {
    if (!mpActions || busy) return;
    const name = draftName.trim();
    if (name.length === 0) { setError('Give the design a name first.'); return; }
    setBusy(true);
    setError(null);
    const res = selected
      ? await mpActions.updateDesign(selected.id, {
          name, parts: draftParts, iconVariant: draftIcon ?? null,
          ...(setActive ? { isActive: true } : {}),
        })
      : await mpActions.createDesign({
          shipClass: activeClass, name, parts: draftParts,
          iconVariant: draftIcon, setActive,
        });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    await refresh();
    if (!selected) loadDesign(null);  // clear the "new design" form
  };

  const setActiveDesign = async (d: ShipDesign, active: boolean) => {
    if (!mpActions || busy) return;
    setBusy(true);
    const res = await mpActions.updateDesign(d.id, { isActive: active });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    await refresh();
  };

  const deleteDesign = async (d: ShipDesign) => {
    if (!mpActions || busy) return;
    setBusy(true);
    const res = await mpActions.deleteDesign(d.id);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    if (selectedId === d.id) loadDesign(null);
    await refresh();
  };

  // MP-only feature — GameUI already gates the mount, but be defensive.
  if (!mpActions) return null;

  const iconVariant = draftIcon ?? DEFAULT_SHIP_ICONS[activeClass];
  const allowedParts = ALL_PART_IDS.filter(p => SHIP_PART_DEFS[p].allowedOn.includes(activeClass));

  return (
    <div className="ship-designer-overlay" onClick={onClose}>
      <div className="ship-designer" onClick={e => e.stopPropagation()}>
        <div className="ship-designer__header">
          <span className="ship-designer__title">Ship Designer</span>
          <button className="ship-designer__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ship-designer__body">
          {/* Class tabs */}
          <div className="ship-designer__tabs">
            {BUILDABLE_CLASSES.map(cls => (
              <button
                key={cls}
                className={`ship-designer__tab ${cls === activeClass ? 'active' : ''}`}
                onClick={() => switchClass(cls)}
              >
                <ShipIcon shipClass={cls} size={14} />
                {SHIP_CLASSES[cls].displayName} · {SHIP_SLOT_COUNTS[cls]} slot{SHIP_SLOT_COUNTS[cls] === 1 ? '' : 's'}
              </button>
            ))}
          </div>
          {activeClass === 'freighter' && (
            <div className="ship-designer__hint">
              Freighters take engine or shield parts only — they haul, they don't fight.
            </div>
          )}

          {/* Design library for this class */}
          <div className="ship-designer__section-title">
            Saved {SHIP_CLASSES[activeClass].displayName} designs
          </div>
          {classDesigns.length === 0 ? (
            <div className="ship-designer__hint">
              No designs yet. A build with no active design launches the bare hull (today's stats, no extra cost).
            </div>
          ) : (
            <div className="ship-designer__list">
              {classDesigns.map(d => (
                <div
                  key={d.id}
                  className={`ship-designer__list-row ${d.id === selectedId ? 'selected' : ''}`}
                  onClick={() => loadDesign(d)}
                >
                  <ShipIcon shipClass={d.shipClass} variant={d.iconVariant} size={16} />
                  <span className="ship-designer__list-row-name">
                    {d.name}
                    <span style={{ color: '#8aa0b4', marginLeft: 6, fontSize: 9 }}>
                      {d.parts.length === 0 ? 'bare hull' : d.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                    </span>
                  </span>
                  {d.isActive ? (
                    <span className="ship-designer__badge" title="BUILD uses this design for this class">ACTIVE</span>
                  ) : (
                    <button
                      className="ship-designer__mini-btn"
                      disabled={busy}
                      onClick={e => { e.stopPropagation(); setActiveDesign(d, true); }}
                      title="Make this the design BUILD uses for this class"
                    >SET ACTIVE</button>
                  )}
                  {d.isActive && (
                    <button
                      className="ship-designer__mini-btn"
                      disabled={busy}
                      onClick={e => { e.stopPropagation(); setActiveDesign(d, false); }}
                      title="Deactivate — builds fall back to the bare hull"
                    >UNSET</button>
                  )}
                  <button
                    className="ship-designer__mini-btn ship-designer__mini-btn--danger"
                    disabled={busy}
                    onClick={e => { e.stopPropagation(); deleteDesign(d); }}
                    title="Delete this design (queued and completed ships keep their loadout)"
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Editor */}
          <div className="ship-designer__section-title">
            {selected ? `Editing: ${selected.name}` : 'New design'}
          </div>
          <div className="ship-designer__name-row">
            <input
              className="ship-designer__name-input"
              placeholder="Design name (e.g. Brawler MkII)"
              value={draftName}
              maxLength={32}
              onChange={e => setDraftName(e.target.value)}
            />
            <button
              className="ship-designer__icon-btn"
              onClick={() => {
                const cur = ALL_VARIANTS.indexOf(iconVariant);
                setDraftIcon(ALL_VARIANTS[(cur + 1) % ALL_VARIANTS.length]);
              }}
              title={`Icon: ${ICON_VARIANT_NAMES[activeClass][iconVariant]} (click to cycle)`}
            >
              <ShipIcon shipClass={activeClass} variant={iconVariant} size={18} />
              {ICON_VARIANT_NAMES[activeClass][iconVariant]}
            </button>
            {selected && (
              <button className="ship-designer__mini-btn" onClick={() => loadDesign(null)}>
                + NEW
              </button>
            )}
          </div>

          {/* Slot pips */}
          <div className="ship-designer__slots">
            SLOTS
            {Array.from({ length: slots }).map((_, i) => {
              const part = draftParts[i] as ShipPartId | undefined;
              return (
                <span
                  key={i}
                  className={`ship-designer__slot-pip ${part ? 'filled' : ''} ${part === 'detonator' ? 'detonator' : ''}`}
                  title={part ? SHIP_PART_DEFS[part].name : 'Empty slot (free)'}
                >
                  {part ? PART_GLYPH[part] : ''}
                </span>
              );
            })}
            <span style={{ color: '#8aa0b4' }}>{draftParts.length}/{slots} · empty slots are free</span>
          </div>

          {/* Part cards */}
          {allowedParts.map(pid => {
            const def = SHIP_PART_DEFS[pid];
            const n = countPart(draftParts, pid);
            const isDet = pid === 'detonator';
            return (
              <div key={pid} className={`ship-designer__part ${isDet ? 'ship-designer__part--detonator' : ''}`}>
                <div className="ship-designer__part-info">
                  <div className="ship-designer__part-name">{PART_GLYPH[pid]} {def.name}</div>
                  <div className="ship-designer__part-blurb">{def.blurb}</div>
                  <div className="ship-designer__part-tech">{def.techNote}</div>
                  <div className="ship-designer__part-cost">{def.cost.ore}M {def.cost.credits}C per part</div>
                  {isDet && n > 0 && (
                    // REQUIRED disclosure (spec §2.2): damage number +
                    // friendly fire + ship consumed — all three, always.
                    <div className="ship-designer__part-warning">
                      ⚠ {detonatorDisclosure(detDamage)}
                    </div>
                  )}
                </div>
                <div className="ship-designer__count">
                  <button
                    className="ship-designer__count-btn"
                    disabled={n === 0}
                    onClick={() => removePart(pid)}
                    aria-label={`Remove a ${def.name}`}
                  >−</button>
                  <span className="ship-designer__count-num">{n}</span>
                  <button
                    className="ship-designer__count-btn"
                    disabled={draftParts.length >= slots}
                    onClick={() => addPart(pid)}
                    aria-label={`Add a ${def.name}`}
                  >+</button>
                </div>
              </div>
            );
          })}

          {/* Computed stats (tech multipliers applied) */}
          <div className="ship-designer__section-title">Computed stats · your current tech applied</div>
          <div className="ship-designer__stats">
            <div className="ship-designer__stat">
              <div className="ship-designer__stat-label">Max HP</div>
              <div className="ship-designer__stat-value">
                {stats.hp}
                {stats.hp !== bare.hp && (
                  <span className="ship-designer__stat-delta">(+{stats.hp - bare.hp})</span>
                )}
              </div>
            </div>
            <div className="ship-designer__stat">
              <div className="ship-designer__stat-label">Damage / volley</div>
              <div className="ship-designer__stat-value">
                {stats.damagePerTick}
                {stats.damagePerTick !== bare.damagePerTick && (
                  <span className="ship-designer__stat-delta">
                    (+{Math.round((stats.damagePerTick - bare.damagePerTick) * 10) / 10})
                  </span>
                )}
              </div>
            </div>
            <div className="ship-designer__stat">
              <div className="ship-designer__stat-label">Travel time</div>
              <div className="ship-designer__stat-value">
                ×{stats.travelTimeMult.toFixed(2)}
                {stats.travelTimeMult < 1 && (
                  <span className="ship-designer__stat-delta">
                    (−{Math.round((1 - stats.travelTimeMult) * 100)}%)
                  </span>
                )}
              </div>
            </div>
            <div className="ship-designer__stat">
              <div className="ship-designer__stat-label">Cost / ship</div>
              <div className="ship-designer__stat-value">
                {hullDef.cost.ore + draftCost.ore}M {hullDef.cost.credits + draftCost.credits}C
                {(draftCost.ore > 0 || draftCost.credits > 0) && (
                  <span className="ship-designer__stat-delta">
                    (hull {hullDef.cost.ore}M {hullDef.cost.credits}C + parts {draftCost.ore}M {draftCost.credits}C)
                  </span>
                )}
              </div>
            </div>
            {nDetonators > 0 && (
              <div className="ship-designer__stat">
                <div className="ship-designer__stat-label">Detonation</div>
                <div className="ship-designer__stat-value" style={{ color: '#ff5e5e' }}>
                  {detDamage} dmg
                </div>
              </div>
            )}
          </div>
          <div className="ship-designer__hint">
            Hull base: {SERVER_HULL_BASE[activeClass].hp} HP · {SERVER_HULL_BASE[activeClass].damagePerTick} dmg.
            Parts scale off the hull base; Weapons/Armor/Propulsion research boosts part effects.
            The ACTIVE design is snapshot onto each build at queue time — editing a design never changes ships already queued or flying.
          </div>

          {error && (
            <button className="ship-designer__error" onClick={() => setError(null)} title="Click to dismiss">
              ⚠ {error}
            </button>
          )}

          <div className="ship-designer__actions">
            <button
              className="ship-designer__btn ship-designer__btn--primary"
              disabled={busy || draftName.trim().length === 0}
              onClick={() => save(true)}
              title="Save this design and make it the one BUILD uses for this class"
            >
              {selected ? 'SAVE & SET ACTIVE' : 'CREATE & SET ACTIVE'}
            </button>
            <button
              className="ship-designer__btn"
              disabled={busy || draftName.trim().length === 0}
              onClick={() => save(false)}
              title="Save without changing which design is active"
            >
              {selected ? 'SAVE' : 'CREATE'}
            </button>
            {selected && (
              <button
                className="ship-designer__btn ship-designer__btn--danger"
                disabled={busy}
                onClick={() => deleteDesign(selected)}
              >
                DELETE
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Convenience: open the designer from anywhere (FleetPanel button,
 *  BuildPanel quick-link). GameUI listens and mounts the overlay. */
export function openShipDesigner(shipClass?: ShipClassName) {
  window.dispatchEvent(new CustomEvent('orbital:open-ship-designer', {
    detail: { shipClass },
  }));
}
