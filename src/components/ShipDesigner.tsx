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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions, ServerShipDesign, ServerShipTemplate } from '../multiplayer/MultiplayerActionsContext';
import { logUiEvent } from '../multiplayer/telemetry';
import { ShipClassName, SHIP_CLASSES, BUILDABLE_CLASSES } from '../game/shipClasses';
import {
  ShipPartId, ALL_PART_IDS, SHIP_PART_DEFS, SHIP_SLOT_COUNTS,
  sanitizeParts, computeDesignStats, partsCost, countPart,
  detonatorDamage, detonatorDisclosure, SERVER_HULL_BASE, PART_GLYPH,
  damageProfile,
} from '../game/shipParts';
import {
  ShipIcon, ShipIconVariant, ALL_VARIANTS, ICON_VARIANT_NAMES, DEFAULT_SHIP_ICONS,
} from './ShipIcons';
import type { ShipDesign } from '../types';
import { PART_FEATURE } from '../game/researchUnlocks';
import { useFeatureGate } from '../hooks/useFeatureGate';
import './ShipDesigner.css';

interface ShipDesignerProps {
  /** Class tab to open on (the BuildPanel quick-link passes the row's
   *  class). Defaults to corvette. */
  initialClass?: ShipClassName;
  onClose: () => void;
}

/** Map a server design row to the client shape (mirrors the
 *  MultiplayerGameProvider deserializer). */
/** Client shape for a cross-game template. Mirrors ShipDesign minus the
 *  per-game `isActive` pointer — a template is inert until loaded. */
interface ShipTemplate {
  id: string;
  shipClass: ShipClassName;
  name: string;
  parts: string[];
  iconVariant?: ShipDesign['iconVariant'];
  createdAtMs: number;
}

function serverTemplateToClient(t: ServerShipTemplate): ShipTemplate {
  let parts: string[] = [];
  if (t.parts_json) {
    try { parts = sanitizeParts(JSON.parse(t.parts_json)); } catch { /* bare hull */ }
  }
  let iv: ShipDesign['iconVariant'];
  if (t.icon_variant && /^[A-F]$/.test(t.icon_variant)) {
    iv = t.icon_variant as ShipDesign['iconVariant'];
  }
  return {
    id: t.id,
    shipClass: (BUILDABLE_CLASSES.includes(t.ship_class as ShipClassName)
      ? t.ship_class
      : 'frigate') as ShipClassName,
    name: t.name,
    parts,
    iconVariant: iv,
    createdAtMs: t.created_at_ms,
  };
}

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

// PART_GLYPH now lives in ../game/shipParts (shared with FleetPanel's
// loadout summary) so the two never drift.

export const ShipDesigner: React.FC<ShipDesignerProps> = ({ initialClass, onClose }) => {
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  useEffect(() => { logUiEvent(mpActions?.gameId, 'ship-designer'); }, [mpActions?.gameId]);
  const gate = useFeatureGate();

  const [activeClass, setActiveClass] = useState<ShipClassName>(initialClass ?? 'corvette');
  // Fresh server copy after a mutation; null = use the /state mirror.
  const [freshDesigns, setFreshDesigns] = useState<ShipDesign[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftParts, setDraftParts] = useState<ShipPartId[]>([]);
  const [draftIcon, setDraftIcon] = useState<ShipIconVariant | undefined>(undefined);
  const [iconMenuOpen, setIconMenuOpen] = useState(false);
  const iconDropdownRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Cross-game template library. null = still loading (distinct from
   *  [] = loaded-and-empty, so the UI can say "loading" vs "none yet"). */
  const [templates, setTemplates] = useState<ShipTemplate[] | null>(null);

  // Close the icon dropdown on any outside click while it's open.
  useEffect(() => {
    if (!iconMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (iconDropdownRef.current && !iconDropdownRef.current.contains(e.target as Node)) {
        setIconMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [iconMenuOpen]);

  // Load the account-level template library once when the designer opens.
  // Templates aren't part of /state (they're user-scoped, not game-scoped),
  // so they need their own fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!mpActions) { setTemplates([]); return; }
      const rows = await mpActions.getShipTemplates();
      if (!cancelled && rows) setTemplates(rows.map(serverTemplateToClient));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes the icon dropdown first if it's open, otherwise the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (iconMenuOpen) { setIconMenuOpen(false); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, iconMenuOpen]);

  const stateDesigns = gameState.shipDesigns;
  const classDesigns = useMemo(() => {
    const all = freshDesigns ?? stateDesigns ?? [];
    return all.filter(d => d.shipClass === activeClass);
  }, [freshDesigns, stateDesigns, activeClass]);
  const selected = classDesigns.find(d => d.id === selectedId) ?? null;
  const classTemplates = useMemo(
    () => (templates ?? []).filter(t => t.shipClass === activeClass),
    [templates, activeClass],
  );

  const techLevels = gameState.factionTech['player']?.levels ?? {};
  const slots = SHIP_SLOT_COUNTS[activeClass];
  const hullDef = SHIP_CLASSES[activeClass];
  const stats = computeDesignStats(activeClass, draftParts, techLevels);
  const bare = computeDesignStats(activeClass, [], {});
  const draftCost = partsCost(draftParts);
  const nDetonators = countPart(draftParts, 'detonator');

  // Combat-profile readout: what this hull deals and what it shrugs off,
  // so the counter-matrix is legible at design time. Bare/weaponless
  // hulls fire kinetic by default (matches the combat resolver).
  const nKinetic = countPart(draftParts, 'kinetic');
  const nEnergy = countPart(draftParts, 'energy');
  const nShields = countPart(draftParts, 'shield');
  const nArmor = countPart(draftParts, 'armor');
  const prof = damageProfile(draftParts);
  const dmgTypeLabel = nKinetic + nEnergy === 0
    ? '⚔ Kinetic (bare)'
    : nEnergy === 0 ? '⚔ Kinetic'
    : nKinetic === 0 ? '⚡ Energy'
    : `⚔ ${Math.round(prof.kinetic * 100)}% / ⚡ ${Math.round(prof.energy * 100)}%`;
  const defLabel = nShields === 0 && nArmor === 0
    ? 'Unshielded'
    : [nShields > 0 ? `🛡×${nShields} vs kinetic` : '', nArmor > 0 ? `🪨×${nArmor} vs energy` : '']
        .filter(Boolean).join(' · ');
  // One-line tactical read of the matchup this build wins/loses.
  const matchupHint = (() => {
    const parts: string[] = [];
    if (nEnergy > 0 && nKinetic === 0) parts.push('Strong vs shielded targets; weak vs armored.');
    else if (nKinetic > 0 && nEnergy === 0) parts.push('Strong vs armored targets; weak vs shielded.');
    else if (nKinetic > 0 && nEnergy > 0) parts.push('Mixed guns — no hard counter, no hard weakness.');
    if (nShields > 0 && nArmor === 0) parts.push('Vulnerable to energy.');
    else if (nArmor > 0 && nShields === 0) parts.push('Vulnerable to kinetic.');
    return parts.join(' ');
  })();
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

  const refreshTemplates = async () => {
    if (!mpActions) return;
    const rows = await mpActions.getShipTemplates();
    // Keep null on failure so the UI shows "loading" rather than lying
    // with "no templates yet" when the request simply errored.
    if (rows) setTemplates(rows.map(serverTemplateToClient));
  };

  /** Load a template into the EDITOR as a new unsaved design. Clears
   *  selectedId so saving creates a fresh design rather than silently
   *  overwriting whichever design happened to be selected. */
  const loadTemplate = (t: ShipTemplate) => {
    setSelectedId(null);
    setDraftName(t.name);
    setDraftParts(sanitizeParts(t.parts));
    setDraftIcon(t.iconVariant);
    setError(null);
  };

  const saveAsTemplate = async () => {
    if (!mpActions) return;
    const name = draftName.trim();
    if (!name) { setError('Name the loadout before saving it as a template.'); return; }
    setBusy(true);
    const res = await mpActions.saveShipTemplate({
      shipClass: activeClass,
      name,
      parts: draftParts,
      iconVariant: draftIcon,
    });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setError(null);
    await refreshTemplates();
  };

  const deleteTemplate = async (t: ShipTemplate) => {
    if (!mpActions) return;
    setBusy(true);
    const res = await mpActions.deleteShipTemplate(t.id);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    await refreshTemplates();
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
            {BUILDABLE_CLASSES.filter(cls => (SHIP_SLOT_COUNTS[cls] ?? 0) > 0).map(cls => (
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

          {/* Cross-game template library. Designs live and die with a
              game; templates live on the account, so a loadout you like
              survives into the next match. Loading one drops it into the
              editor below — it doesn't become a design until you save. */}
          <div className="ship-designer__section-title">
            Templates <span style={{ color: '#8aa0b4', fontWeight: 400 }}>· saved across games</span>
          </div>
          {templates === null ? (
            <div className="ship-designer__hint">Loading templates…</div>
          ) : classTemplates.length === 0 ? (
            <div className="ship-designer__hint">
              No saved {SHIP_CLASSES[activeClass].displayName.toLowerCase()} templates. Build a loadout below and
              hit SAVE AS TEMPLATE to reuse it in future games.
            </div>
          ) : (
            <div className="ship-designer__list">
              {classTemplates.map(t => (
                <div key={t.id} className="ship-designer__list-row">
                  <ShipIcon shipClass={activeClass} variant={t.iconVariant} size={16} />
                  <span className="ship-designer__list-row-name">
                    {t.name}
                    <span style={{ color: '#8aa0b4', marginLeft: 6, fontSize: 9 }}>
                      {t.parts.length === 0 ? 'bare hull' : t.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                    </span>
                  </span>
                  <button
                    className="ship-designer__mini-btn"
                    disabled={busy}
                    onClick={() => loadTemplate(t)}
                    title="Load this loadout into the editor"
                  >LOAD</button>
                  <button
                    className="ship-designer__mini-btn ship-designer__mini-btn--danger"
                    disabled={busy}
                    onClick={() => deleteTemplate(t)}
                    title="Delete this saved template"
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
            <div className="ship-designer__icon-dd" ref={iconDropdownRef}>
              <button
                type="button"
                className={`ship-designer__icon-btn ${iconMenuOpen ? 'open' : ''}`}
                onClick={() => setIconMenuOpen(o => !o)}
                aria-haspopup="listbox"
                aria-expanded={iconMenuOpen}
                title="Change ship icon"
              >
                <ShipIcon shipClass={activeClass} variant={iconVariant} size={18} />
                <span className="ship-designer__icon-btn-name">
                  {ICON_VARIANT_NAMES[activeClass][iconVariant]}
                </span>
                <span className="ship-designer__icon-caret" aria-hidden>▾</span>
              </button>
              {iconMenuOpen && (
                <div className="ship-designer__icon-menu" role="listbox" aria-label="Ship icon">
                  <div className="ship-designer__icon-menu-title">Icon</div>
                  {ALL_VARIANTS.map(v => {
                    const isDefault = v === DEFAULT_SHIP_ICONS[activeClass];
                    return (
                      <button
                        key={v}
                        type="button"
                        role="option"
                        aria-selected={v === iconVariant}
                        className={`ship-designer__icon-option ${v === iconVariant ? 'selected' : ''}`}
                        onClick={() => { setDraftIcon(v); setIconMenuOpen(false); }}
                      >
                        <ShipIcon shipClass={activeClass} variant={v} size={22} />
                        <span className="ship-designer__icon-option-name">
                          {ICON_VARIANT_NAMES[activeClass][v]}
                          {isDefault && <span className="ship-designer__icon-default"> · default</span>}
                        </span>
                        {v === iconVariant && <span className="ship-designer__icon-check" aria-hidden>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
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
            // Research gate. Locked parts stay listed so the designer
            // doubles as a preview of the counter-matrix — you can read
            // what energy mounts do before you can fit one.
            const lock = gate.lockReason(PART_FEATURE[pid]);
            return (
              <div
                key={pid}
                className={`ship-designer__part ${isDet ? 'ship-designer__part--detonator' : ''}`}
                style={lock ? { opacity: 0.55 } : undefined}
              >
                <div className="ship-designer__part-info">
                  <div className="ship-designer__part-name">{PART_GLYPH[pid]} {def.name}</div>
                  <div className="ship-designer__part-blurb">{def.blurb}</div>
                  <div className="ship-designer__part-tech">{def.techNote}</div>
                  <div className="ship-designer__part-cost">{def.cost.ore}M {def.cost.credits}C per part</div>
                  {lock && (
                    <div className="ship-designer__part-tech" style={{ color: '#8aa0b4' }}>
                      🔒 {lock.text}
                    </div>
                  )}
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
                    disabled={!!lock || draftParts.length >= slots}
                    onClick={() => addPart(pid)}
                    title={lock ? `${lock.label} — ${lock.text}` : undefined}
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
              <div className="ship-designer__stat-label">Damage type</div>
              <div className="ship-designer__stat-value">{dmgTypeLabel}</div>
            </div>
            <div className="ship-designer__stat">
              <div className="ship-designer__stat-label">Defense</div>
              <div className="ship-designer__stat-value">{defLabel}</div>
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
          {matchupHint && (
            <div className="ship-designer__hint ship-designer__hint--matchup">
              ⚔ vs 🛡 · {matchupHint}
            </div>
          )}
          <div className="ship-designer__hint">
            <strong>Kinetic ⚔</strong> chews armor, shields blunt it. <strong>Energy ⚡</strong> melts shields, armor scatters it.
            Each 🛡/🪨 cuts its countered damage type to 78% (stacking). Hull base:{' '}
            {SERVER_HULL_BASE[activeClass].hp} HP · {SERVER_HULL_BASE[activeClass].damagePerTick} dmg.
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
            <button
              className="ship-designer__btn"
              disabled={busy || draftName.trim().length === 0}
              onClick={saveAsTemplate}
              title="Save this loadout to your account so you can load it in future games"
            >
              SAVE AS TEMPLATE
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
