// ============================================================
// ShipDesigner — multiplayer-only design library + loadout editor.
// DESIGN-identity-economy.md §2 (data model) + DESIGN-fleet-economy §4
// (this layout rebuild) + §2 (fleet refit bar).
//
// Layout (UX-juror adjudicated, 2026-08):
//   - Dominant center CANVAS: big ship avatar with its equip slots as a
//     RING of sockets orbiting it. Drag a part card onto a socket, or
//     click/tap a card to fit the first empty socket (touch fallback).
//     Click a filled socket to unfit it. Invalid drops are refused
//     visibly with a reason toast.
//   - Collapsible bottom DRAWER: the part palette as compact rows —
//     icon, name, one-line effect, visible "countered by" micro-text
//     (counter-play is a decision input, not flavor), and the NEXT
//     copy's escalated price.
//   - Slim always-visible right SIDEBAR: stat readout with
//     before→after deltas (vs the saved design being edited, or the
//     bare hull for a new design), total cost, per-tick upkeep, and
//     the fleet-refit summary bar ("N live hulls — refit for X").
//   - Mobile (narrow / mobile shell): single scrolling column — canvas
//     pinned at top, palette scrolls, stats as a sticky footer with an
//     expandable detail sheet.
//
// Data flow unchanged from the original designer: the design library
// arrives on every /state poll (gameState.shipDesigns); mutations post
// through mpActions then refresh via GET /designs. The server is
// authoritative on validation (slots, part compatibility, one active
// per class) and on every price actually charged.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions, ServerShipDesign, ServerShipTemplate } from '../multiplayer/MultiplayerActionsContext';
import { logUiEvent } from '../multiplayer/telemetry';
import { ShipClassName, SHIP_CLASSES, BUILDABLE_CLASSES, SHIP_UPKEEP } from '../game/shipClasses';
import { deliveredHullHp } from '../game/combat';
import {
  ShipPartId, ALL_PART_IDS, SHIP_PART_DEFS, SHIP_SLOT_COUNTS,
  sanitizeParts, computeDesignStats, partsCost, countPart,
  detonatorDamage, detonatorDisclosure, SERVER_HULL_BASE, PART_GLYPH,
  damageProfile, refitFee, PART_STACK_ESCALATION, mitigationPct,
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
  if (t.icon_variant && /^[A-I]$/.test(t.icon_variant)) {
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
  if (d.icon_variant && /^[A-I]$/.test(d.icon_variant)) {
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

/** "Countered by" micro-text per part — visible on the card, not hidden
 *  in a tooltip: what beats this choice is a decision input. */
const COUNTER_TEXT: Partial<Record<ShipPartId, string>> = {
  kinetic: 'each 🛡 shield cuts it to 78%',
  energy: 'each 🪨 armor plate cuts it to 78%',
  shield: 'does nothing against ⚡ energy',
  armor: 'does nothing against ⚔ kinetic',
};

/** Escalated price of the NEXT copy given n already fitted. Mirrors the
 *  per-copy rounding in partsCost so quote == charge. */
function nextCopyCost(pid: ShipPartId, n: number): { ore: number; credits: number } {
  const def = SHIP_PART_DEFS[pid];
  const mul = Math.pow(PART_STACK_ESCALATION, n);
  return { ore: Math.round(def.cost.ore * mul), credits: Math.round(def.cost.credits * mul) };
}

const sameLoadout = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join(',') === [...b].sort().join(',');

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
  /** Cross-game template library. null = still loading. */
  const [templates, setTemplates] = useState<ShipTemplate[] | null>(null);
  /** Part id being dragged from the palette (sockets pulse while set). */
  const [dragging, setDragging] = useState<ShipPartId | null>(null);
  /** Transient refusal toast ("Slots full — unfit a part first"). */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Palette drawer collapse (desktop). Mobile always shows it inline. */
  const [drawerOpen, setDrawerOpen] = useState(true);
  /** Library strip collapse — designs/templates picker above the canvas. */
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** Mobile stat sheet expansion (sticky footer → full detail). */
  const [statsSheetOpen, setStatsSheetOpen] = useState(false);
  /** Refit-bar feedback ("Refitted 4, 2 pending"). */
  const [refitNote, setRefitNote] = useState<string | null>(null);

  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2200);
  };
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

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
  // Quote the hull the yard will DELIVER. computeDesignStats returns the
  // build-time base (what gets stored as hp_max); worker/room.js spawns
  // at base × defense tech, so the raw number reads far short of the ship
  // you actually get — 40 vs 72 for a corvette at Defense 10.
  const playerTech = gameState.factionTech['player'];
  const hpOut = (n: number) => deliveredHullHp(n, playerTech);
  // Delta baseline: the SAVED loadout when editing an existing design
  // (a real before→after), else the bare hull.
  const baselineParts = useMemo(
    () => (selected ? sanitizeParts(selected.parts) : []),
    [selected],
  );
  const base = computeDesignStats(activeClass, baselineParts, techLevels);
  const draftCost = partsCost(draftParts);
  const nDetonators = countPart(draftParts, 'detonator');
  const upkeepMult = gameState.fleetUpkeep?.multiplier ?? 1;
  const upkeep = SHIP_UPKEEP[activeClass];
  const upkeepLabel = (upkeep.credits * upkeepMult) > 0 || (upkeep.ore * upkeepMult) > 0
    ? [
        upkeep.credits * upkeepMult > 0 ? `${(upkeep.credits * upkeepMult).toFixed(2).replace(/\.?0+$/, '')}C` : null,
        upkeep.ore * upkeepMult > 0 ? `${(upkeep.ore * upkeepMult).toFixed(2).replace(/\.?0+$/, '')}M` : null,
      ].filter(Boolean).join(' + ') + ' /tick'
    : 'free';

  // Combat-profile readout: what this hull deals and what it shrugs off.
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
  // The old hint said "strong vs armored targets", which read as a damage
  // BONUS. There is none: defenseMitigation only ever reduces, so the
  // off-counter simply arrives at 100%. Both lines below quote the real
  // multiplier, and the incoming line quotes THIS draft's actual stack.
  const outgoingHint = (() => {
    if (nKinetic > 0 && nEnergy > 0) return 'Mixed guns — each type is cut only by its own counter.';
    if (nKinetic > 0) return '⚔ Kinetic: 100% through 🪨 armor · cut to 78% by each 🛡 shield.';
    if (nEnergy > 0) return '⚡ Energy: 100% through 🛡 shields · cut to 78% by each 🪨 armor plate.';
    return '';
  })();
  const incomingHint = (() => {
    if (nShields === 0 && nArmor === 0) return 'No 🛡/🪨 fitted — all incoming damage lands at 100%.';
    const kin = nShields > 0
      ? `⚔ kinetic → ${mitigationPct(nShields)}%`
      : '⚔ kinetic → 100%';
    const nrg = nArmor > 0
      ? `⚡ energy → ${mitigationPct(nArmor)}%`
      : '⚡ energy → 100%';
    return `Incoming: ${kin} · ${nrg}`;
  })();
  const detDamage = detonatorDamage(stats.hp, nDetonators, techLevels.weapons ?? 0);

  // --- Fleet refit summary (§2, juror Q7-A) --------------------------
  // Live hulls of this class whose CURRENT parts differ from the
  // selected design's saved loadout — one bar, one bill, one button.
  const refitInfo = useMemo(() => {
    if (!selected) return null;
    const target = sanitizeParts(selected.parts);
    // /state only ships active hulls, so no destroyed-filter needed.
    const mine = gameState.ships.filter(s =>
      s.ownedBy === 'player' && s.class === activeClass);
    let hulls = 0, ore = 0, credits = 0, pendingAlready = 0;
    for (const s of mine) {
      if (s.refitPendingDesignId === selected.id) { pendingAlready++; continue; }
      const cur = sanitizeParts(s.parts ?? []);
      if (sameLoadout(cur, target)) continue;
      const fee = refitFee(cur, target);
      hulls++;
      ore += fee.ore;
      credits += fee.credits;
    }
    return { hulls, ore, credits, pendingAlready };
  }, [selected, gameState.ships, activeClass]);
  const draftMatchesSelected = selected != null && sameLoadout(draftParts, baselineParts);

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
    setRefitNote(null);
  };

  const refreshTemplates = async () => {
    if (!mpActions) return;
    const rows = await mpActions.getShipTemplates();
    if (rows) setTemplates(rows.map(serverTemplateToClient));
  };

  /** Load a template into the editor as a new unsaved design. */
  const loadTemplate = (t: ShipTemplate) => {
    setSelectedId(null);
    setDraftName(t.name);
    setDraftParts(sanitizeParts(t.parts));
    setDraftIcon(t.iconVariant);
    setError(null);
    setRefitNote(null);
  };

  const saveAsTemplate = async () => {
    if (!mpActions) return;
    const name = draftName.trim();
    if (!name) { setError('Name the loadout before saving it as a template.'); return; }
    setBusy(true);
    const res = await mpActions.saveShipTemplate({
      shipClass: activeClass, name, parts: draftParts, iconVariant: draftIcon,
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
    setRefitNote(null);
  };

  // --- Fit / unfit ----------------------------------------------------
  /** Why a part can't be fitted right now, or null when it can. */
  // First-open drag affordance (P4 polish): nothing on desktop said the
  // part cards were draggable — new players tapped around the canvas
  // looking for an "add" button. A one-time ghost hint floats over the
  // canvas until the player fits their first part, ever.
  const [dragHintSeen, setDragHintSeen] = useState(() => {
    try { return localStorage.getItem('orbital.sd_drag_hint') === '1'; } catch { return true; }
  });
  const dismissDragHint = () => {
    if (dragHintSeen) return;
    setDragHintSeen(true);
    try { localStorage.setItem('orbital.sd_drag_hint', '1'); } catch { /* noop */ }
  };

  const fitRefusal = (pid: ShipPartId, slotIdx?: number): string | null => {
    const lock = gate.lockReason(PART_FEATURE[pid]);
    if (lock) return `🔒 ${SHIP_PART_DEFS[pid].name} is locked — ${lock.text}`;
    // Replacing a filled socket frees its slot, so only a fit into an
    // EMPTY socket can overflow.
    const replacing = slotIdx != null && draftParts[slotIdx] != null;
    if (!replacing && draftParts.length >= slots) {
      return `All ${slots} slots are fitted — tap a socket to unfit a part first.`;
    }
    return null;
  };

  /** Fit into the first empty slot (click/tap-to-fit). */
  const fitPart = (pid: ShipPartId) => {
    const why = fitRefusal(pid);
    if (why) { showFlash(why); return; }
    dismissDragHint();
    setDraftParts(prev => [...prev, pid]);
  };

  /** Drop onto a specific socket: fill it, or swap out what's there. */
  const dropOnSocket = (pid: ShipPartId, slotIdx: number) => {
    const why = fitRefusal(pid, slotIdx);
    if (why) { showFlash(why); return; }
    dismissDragHint();
    setDraftParts(prev => {
      const next = [...prev];
      // draftParts is contiguous (unfit closes gaps), so empty sockets
      // are exactly the indices >= length — clamping keeps the visual
      // drop target and the filled socket aligned (QA finding: dropping
      // on ring position 5 used to fill position 2).
      if (slotIdx < next.length) next[slotIdx] = pid;   // replace in place
      else next.push(pid);                              // fills the next ring position
      return next;
    });
  };

  const unfitSocket = (slotIdx: number) => {
    setDraftParts(prev => prev.filter((_, i) => i !== slotIdx));
  };

  const save = async (setActive: boolean) => {
    if (!mpActions || busy) return;
    // Auto-name when the field is blank — a disabled save button with no
    // stated reason reads as "there is no way to save" (playtest). The
    // player can rename any time; a generated mark number beats a wall.
    let name = draftName.trim();
    if (name.length === 0) {
      const taken = new Set(classDesigns.map(d => d.name));
      let mk = classDesigns.length + 1;
      do { name = `${SHIP_CLASSES[activeClass].displayName} Mk ${mk}`; mk++; } while (taken.has(name));
    }
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
    if (setActive) {
      // Say what "active" MEANS, right where the click happened — the
      // save-then-deploy loop was invisible to playtesters.
      setRefitNote(`${name} is now ACTIVE — every shipyard BUILD for this class launches this design.`);
    }
    // Keep the (possibly generated) name in the field so the player sees
    // what their design is called; the library list refresh shows it too.
    setDraftName(name);
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

  const doRefitFleet = async () => {
    if (!mpActions || busy || !selected) return;
    setBusy(true);
    setRefitNote(null);
    const res = await mpActions.refitFleet(selected.id);
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'Refit failed.'); return; }
    const done = res.refitted?.length ?? 0;
    const pend = res.pending?.length ?? 0;
    const cost = res.charged;
    setRefitNote(
      `Refitted ${done} hull${done === 1 ? '' : 's'} now`
      + (cost && (cost.ore > 0 || cost.credits > 0) ? ` for ${cost.ore}M ${cost.credits}C` : '')
      + (pend > 0 ? ` · ${pend} pending (refit at next friendly yard)` : '')
      + '.',
    );
  };

  // MP-only feature — GameUI already gates the mount, but be defensive.
  if (!mpActions) return null;

  const iconVariant = draftIcon ?? DEFAULT_SHIP_ICONS[activeClass];
  const allowedParts = ALL_PART_IDS.filter(p => SHIP_PART_DEFS[p].allowedOn.includes(activeClass));
  const activeDesignForClass = classDesigns.find(d => d.isActive) ?? null;

  // Socket ring geometry: N sockets evenly spaced, starting at 12
  // o'clock. Percent-based so the ring scales with the canvas.
  const socketPos = (i: number, n: number) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    const R = 42; // % of canvas half-size
    return {
      left: `${50 + R * Math.cos(angle)}%`,
      top: `${50 + R * Math.sin(angle)}%`,
    };
  };

  // Compact delta chip for the stat sidebar ("120 → 154").
  const Delta: React.FC<{ from: number; to: number; fmt?: (n: number) => string; invert?: boolean }> =
    ({ from, to, fmt = (n) => `${n}`, invert = false }) => {
      if (from === to) return <>{fmt(to)}</>;
      const better = invert ? to < from : to > from;
      return (
        <>
          <span className="sd-delta-from">{fmt(from)}</span>
          <span className="sd-delta-arrow">→</span>
          <span className={better ? 'sd-delta-up' : 'sd-delta-down'}>{fmt(to)}</span>
        </>
      );
    };

  const statRows = (
    <>
      <div className="sd-stat">
        <span className="sd-stat__label">Max HP</span>
        <span className="sd-stat__value"><Delta from={hpOut(base.hp)} to={hpOut(stats.hp)} /></span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">Damage / volley</span>
        <span className="sd-stat__value"><Delta from={base.damagePerTick} to={stats.damagePerTick} /></span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">Damage type</span>
        <span className="sd-stat__value">{dmgTypeLabel}</span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">Defense</span>
        <span className="sd-stat__value">{defLabel}</span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">Travel time</span>
        <span className="sd-stat__value">
          <Delta from={base.travelTimeMult} to={stats.travelTimeMult} fmt={n => `×${n.toFixed(2)}`} invert />
        </span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">Cost / ship</span>
        <span className="sd-stat__value">
          <Delta
            from={base.totalCost.ore} to={hullDef.cost.ore + draftCost.ore}
            fmt={n => `${n}M`} invert
          />
          {' '}
          <Delta
            from={base.totalCost.credits} to={hullDef.cost.credits + draftCost.credits}
            fmt={n => `${n}C`} invert
          />
        </span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">Upkeep</span>
        <span className="sd-stat__value">{upkeepLabel}</span>
      </div>
      {nDetonators > 0 && (
        <div className="sd-stat">
          <span className="sd-stat__label">Detonation</span>
          <span className="sd-stat__value" style={{ color: '#ff5e5e' }}>{detDamage} dmg</span>
        </div>
      )}
    </>
  );

  const refitBar = selected && refitInfo && (refitInfo.hulls > 0 || refitInfo.pendingAlready > 0) && (
    <div className="sd-refit">
      {refitInfo.hulls > 0 ? (
        <>
          <div className="sd-refit__line">
            {refitInfo.hulls} live hull{refitInfo.hulls === 1 ? '' : 's'} differ{refitInfo.hulls === 1 ? 's' : ''} from this template
            {refitInfo.pendingAlready > 0 && <> · {refitInfo.pendingAlready} already pending</>}
          </div>
          <button
            className="sd-btn sd-btn--refit"
            disabled={busy || !draftMatchesSelected}
            onClick={doRefitFleet}
            title={draftMatchesSelected
              ? 'Refit every live hull of this class to this template. Ships at a friendly yard refit now; the rest refit on arrival at one.'
              : 'Save your edits first — the fleet refits to the SAVED template.'}
          >
            ⟳ REFIT FLEET · {refitInfo.ore}M {refitInfo.credits}C
          </button>
          {!draftMatchesSelected && (
            <div className="sd-refit__hint">Unsaved edits — save first, then refit.</div>
          )}
          <div className="sd-refit__hint">
            Fee = half the added parts' price per hull. Removals refund nothing.
          </div>
        </>
      ) : (
        <div className="sd-refit__line">
          {refitInfo.pendingAlready} hull{refitInfo.pendingAlready === 1 ? '' : 's'} pending refit — applies at the next friendly yard.
        </div>
      )}
    </div>
  );

  // Standalone so it also shows after CREATE & SET ACTIVE on a fresh
  // design (the refit bar above only exists once live hulls differ).
  const noteLine = refitNote && <div className="sd-refit__note">{refitNote}</div>;

  const actionButtons = (
    <div className="sd-actions">
      <button
        className="sd-btn sd-btn--primary"
        disabled={busy}
        onClick={() => save(true)}
        title="Save this design and make it the one BUILD uses for this class"
      >
        {selected ? 'SAVE & SET ACTIVE' : 'CREATE & SET ACTIVE'}
      </button>
      <button
        className="sd-btn"
        disabled={busy}
        onClick={() => save(false)}
        title="Save without changing which design is active"
      >
        {selected ? 'SAVE' : 'CREATE'}
      </button>
      <button
        className="sd-btn"
        disabled={busy}
        onClick={saveAsTemplate}
        title="Save this loadout to your account so you can load it in future games"
      >
        SAVE AS TEMPLATE
      </button>
      {selected && (
        <button
          className="sd-btn sd-btn--danger"
          disabled={busy}
          onClick={() => deleteDesign(selected)}
        >
          DELETE
        </button>
      )}
    </div>
  );

  return (
    <div className="ship-designer-overlay" onClick={onClose}>
      <div className="sd" onClick={e => e.stopPropagation()}>
        {/* ---------- Header: title + class tabs + close ---------- */}
        <div className="sd-header">
          <span className="sd-title">SHIP DESIGNER</span>
          <div className="sd-tabs">
            {BUILDABLE_CLASSES.filter(cls => (SHIP_SLOT_COUNTS[cls] ?? 0) > 0).map(cls => (
              <button
                key={cls}
                className={`sd-tab ${cls === activeClass ? 'active' : ''}`}
                onClick={() => switchClass(cls)}
              >
                <ShipIcon shipClass={cls} size={14} />
                <span className="sd-tab__name">{SHIP_CLASSES[cls].displayName}</span>
                <span className="sd-tab__slots">{SHIP_SLOT_COUNTS[cls]}◯</span>
              </button>
            ))}
          </div>
          <button className="sd-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sd-main">
          {/* ---------- Center column: canvas + palette drawer ---------- */}
          <div className="sd-center">
            {/* Library strip: saved designs + cross-game templates. */}
            <div className="sd-library">
              <button
                className="sd-library__toggle"
                onClick={() => setLibraryOpen(o => !o)}
                aria-expanded={libraryOpen}
              >
                {libraryOpen ? '▾' : '▸'} LIBRARY
                <span className="sd-library__meta">
                  {classDesigns.length} design{classDesigns.length === 1 ? '' : 's'}
                  {activeDesignForClass ? ` · active: ${activeDesignForClass.name}` : ' · builds launch bare hull'}
                </span>
              </button>
              {libraryOpen && (
                <div className="sd-library__body">
                  {classDesigns.length === 0 && (
                    <div className="sd-hint">
                      No designs yet. A build with no active design launches the bare hull (base stats, no extra cost).
                    </div>
                  )}
                  {classDesigns.map(d => (
                    <div
                      key={d.id}
                      className={`sd-library__row ${d.id === selectedId ? 'selected' : ''}`}
                      onClick={() => loadDesign(d)}
                    >
                      <ShipIcon shipClass={d.shipClass} variant={d.iconVariant} size={16} />
                      <span className="sd-library__row-name">
                        {d.name}
                        <span className="sd-library__row-parts">
                          {d.parts.length === 0 ? 'bare hull' : d.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                        </span>
                      </span>
                      {d.isActive ? (
                        <>
                          <span className="sd-badge" title="BUILD uses this design for this class">ACTIVE</span>
                          <button
                            className="sd-mini-btn"
                            disabled={busy}
                            onClick={e => { e.stopPropagation(); setActiveDesign(d, false); }}
                            title="Deactivate — builds fall back to the bare hull"
                          >UNSET</button>
                        </>
                      ) : (
                        <button
                          className="sd-mini-btn"
                          disabled={busy}
                          onClick={e => { e.stopPropagation(); setActiveDesign(d, true); }}
                          title="Make this the design BUILD uses for this class"
                        >SET ACTIVE</button>
                      )}
                      <button
                        className="sd-mini-btn sd-mini-btn--danger"
                        disabled={busy}
                        onClick={e => { e.stopPropagation(); deleteDesign(d); }}
                        title="Delete this design (queued and completed ships keep their loadout)"
                      >✕</button>
                    </div>
                  ))}
                  <div className="sd-library__subhead">TEMPLATES · saved across games</div>
                  {templates === null ? (
                    <div className="sd-hint">Loading templates…</div>
                  ) : classTemplates.length === 0 ? (
                    <div className="sd-hint">
                      None yet — build a loadout and hit SAVE AS TEMPLATE to reuse it in future games.
                    </div>
                  ) : classTemplates.map(t => (
                    <div key={t.id} className="sd-library__row">
                      <ShipIcon shipClass={activeClass} variant={t.iconVariant} size={16} />
                      <span className="sd-library__row-name">
                        {t.name}
                        <span className="sd-library__row-parts">
                          {t.parts.length === 0 ? 'bare hull' : t.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                        </span>
                      </span>
                      <button className="sd-mini-btn" disabled={busy} onClick={() => loadTemplate(t)} title="Load this loadout into the editor">LOAD</button>
                      <button className="sd-mini-btn sd-mini-btn--danger" disabled={busy} onClick={() => deleteTemplate(t)} title="Delete this saved template">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Name + icon row */}
            <div className="sd-name-row">
              <input
                className="sd-name-input"
                placeholder={selected ? selected.name : 'Design name (e.g. Brawler MkII)'}
                value={draftName}
                maxLength={32}
                onChange={e => setDraftName(e.target.value)}
              />
              <div className="sd-icon-dd" ref={iconDropdownRef}>
                <button
                  type="button"
                  className={`sd-icon-btn ${iconMenuOpen ? 'open' : ''}`}
                  onClick={() => setIconMenuOpen(o => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={iconMenuOpen}
                  title="Change ship icon"
                >
                  <ShipIcon shipClass={activeClass} variant={iconVariant} size={18} />
                  <span className="sd-icon-caret" aria-hidden>▾</span>
                </button>
                {iconMenuOpen && (
                  <div className="sd-icon-menu" role="listbox" aria-label="Ship icon">
                    {ALL_VARIANTS.map(v => {
                      const isDefault = v === DEFAULT_SHIP_ICONS[activeClass];
                      return (
                        <button
                          key={v}
                          type="button"
                          role="option"
                          aria-selected={v === iconVariant}
                          className={`sd-icon-option ${v === iconVariant ? 'selected' : ''}`}
                          onClick={() => { setDraftIcon(v); setIconMenuOpen(false); }}
                        >
                          <ShipIcon shipClass={activeClass} variant={v} size={22} />
                          <span>
                            {ICON_VARIANT_NAMES[activeClass][v]}
                            {isDefault && <span className="sd-icon-default"> · default</span>}
                          </span>
                          {v === iconVariant && <span aria-hidden>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {selected && (
                <button className="sd-mini-btn" onClick={() => loadDesign(null)}>+ NEW</button>
              )}
            </div>

            {/* ---------- THE CANVAS: avatar + socket ring ---------- */}
            <div className={`sd-canvas ${dragging ? 'sd-canvas--dragging' : ''}`} data-tutorial-id="designer-canvas">
              <div className="sd-canvas__avatar">
                {/* Component avatar: the portrait physically grows the
                    fitted hardware (barrel, emitter, plating, plume,
                    shield bubble) — live, as parts land in sockets. */}
                <ShipIcon shipClass={activeClass} variant={iconVariant} size={96} parts={draftParts} />
                <div className="sd-canvas__hull-name">{SHIP_CLASSES[activeClass].displayName}</div>
              </div>
              {Array.from({ length: slots }).map((_, i) => {
                const part = draftParts[i] as ShipPartId | undefined;
                const pos = socketPos(i, slots);
                const acceptable = dragging != null && (part != null || draftParts.length < slots || i < draftParts.length);
                return (
                  <button
                    key={i}
                    type="button"
                    className={[
                      'sd-socket',
                      part ? 'sd-socket--filled' : 'sd-socket--empty',
                      part === 'detonator' ? 'sd-socket--detonator' : '',
                      dragging && acceptable ? 'sd-socket--accepting' : '',
                    ].filter(Boolean).join(' ')}
                    style={pos}
                    title={part
                      ? `${SHIP_PART_DEFS[part].name} — click to unfit`
                      : 'Empty slot (free) — drag a part here, or tap a part card to fit'}
                    onClick={() => { if (part) unfitSocket(i); }}
                    onDragOver={e => { if (dragging) e.preventDefault(); }}
                    onDrop={e => {
                      e.preventDefault();
                      const pid = (e.dataTransfer.getData('text/orbital-part') || dragging) as ShipPartId | '';
                      if (pid && SHIP_PART_DEFS[pid as ShipPartId]) dropOnSocket(pid as ShipPartId, i);
                      setDragging(null);
                    }}
                  >
                    {part ? PART_GLYPH[part] : '+'}
                  </button>
                );
              })}
              <div className="sd-canvas__slots-label">
                SLOTS {draftParts.length}/{slots} · empty slots are free
              </div>
              {!dragHintSeen && draftParts.length === 0 && slots > 0 && (
                <div className="sd-drag-hint" aria-hidden>
                  ⤵ Drag a part from the tray onto a socket — or just tap a card to fit it
                </div>
              )}
              {flash && <div className="sd-flash" role="alert">⚠ {flash}</div>}
              {nDetonators > 0 && (
                <div className="sd-canvas__det-warning">⚠ {detonatorDisclosure(detDamage)}</div>
              )}
            </div>

            {/* ---------- Palette drawer ---------- */}
            <div className={`sd-drawer ${drawerOpen ? 'open' : ''}`}>
              <button
                className="sd-drawer__toggle"
                onClick={() => setDrawerOpen(o => !o)}
                aria-expanded={drawerOpen}
              >
                {drawerOpen ? '▾' : '▴'} PARTS
                {activeClass === 'freighter' && (
                  <span className="sd-drawer__hint">freighters take engine/shield only — they haul, they don't fight</span>
                )}
              </button>
              {drawerOpen && (
                <div className="sd-drawer__body">
                  {allowedParts.map(pid => {
                    const def = SHIP_PART_DEFS[pid];
                    const n = countPart(draftParts, pid);
                    const isDet = pid === 'detonator';
                    const lock = gate.lockReason(PART_FEATURE[pid]);
                    const next = nextCopyCost(pid, n);
                    const full = !lock && draftParts.length >= slots;
                    return (
                      <div
                        key={pid}
                        className={[
                          'sd-part',
                          isDet ? 'sd-part--detonator' : '',
                          lock ? 'sd-part--locked' : '',
                          dragging === pid ? 'sd-part--dragging' : '',
                        ].filter(Boolean).join(' ')}
                        draggable={!lock}
                        onDragStart={e => {
                          if (lock) { e.preventDefault(); return; }
                          e.dataTransfer.setData('text/orbital-part', pid);
                          e.dataTransfer.effectAllowed = 'copy';
                          setDragging(pid);
                        }}
                        onDragEnd={() => setDragging(null)}
                        onClick={() => { if (!lock) fitPart(pid); else showFlash(`🔒 ${def.name} — ${lock.text}`); }}
                        title={`${def.blurb}\n${def.techNote}${lock ? `\n🔒 ${lock.text}` : ''}\nClick to fit · drag onto a socket`}
                        role="button"
                        aria-disabled={!!lock || full}
                      >
                        <span className="sd-part__glyph">{PART_GLYPH[pid]}</span>
                        <span className="sd-part__text">
                          <span className="sd-part__name">
                            {def.name}
                            {n > 0 && <span className="sd-part__fitted"> ×{n}</span>}
                            {lock && <span className="sd-part__lock"> 🔒</span>}
                          </span>
                          <span className="sd-part__blurb">{def.blurb}</span>
                          {COUNTER_TEXT[pid] && (
                            <span className="sd-part__counter">countered: {COUNTER_TEXT[pid]}</span>
                          )}
                          {isDet && (
                            <span className="sd-part__counter" style={{ color: '#ff8a5c' }}>
                              hits friend AND foe · ship is destroyed
                            </span>
                          )}
                        </span>
                        <span className="sd-part__price" title={n > 0 ? `Copies of the same part escalate ×${PART_STACK_ESCALATION} each` : 'Base price'}>
                          {n > 0 && <span className="sd-part__price-nth">#{n + 1}</span>}
                          {next.ore}M {next.credits}C
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ---------- Right sidebar: stats + refit + actions ---------- */}
          <div className="sd-side" data-tutorial-id="designer-stats">
            <div className="sd-side__title">
              {selected ? `EDITING: ${selected.name}` : 'NEW DESIGN'}
              {selected && !draftMatchesSelected && <span className="sd-side__dirty"> · unsaved</span>}
            </div>
            <div className="sd-side__stats">{statRows}</div>
            {outgoingHint && <div className="sd-hint sd-hint--matchup">{outgoingHint}</div>}
            <div className="sd-hint sd-hint--matchup">{incomingHint}</div>
            <div className="sd-hint">
              <strong>🛡 Shields</strong> only stop ⚔ kinetic. <strong>🪨 Armor</strong> only stops
              ⚡ energy. Each part cuts its own type to 78%, stacking
              ({mitigationPct(1)}% → {mitigationPct(2)}% → {mitigationPct(3)}%); the other type is
              never boosted, it just arrives at 100%.
              Hull base: {SERVER_HULL_BASE[activeClass].hp} HP · {SERVER_HULL_BASE[activeClass].damagePerTick} dmg.
              {hpOut(100) !== 100 && (
                <> Max HP shown includes your defense tech (×{(hpOut(1000) / 1000).toFixed(2)}).</>
              )}
              Builds snapshot the ACTIVE design at queue time.
            </div>
            {refitBar}
            {noteLine}
            {error && (
              <button className="sd-error" onClick={() => setError(null)} title="Click to dismiss">
                ⚠ {error}
              </button>
            )}
            {actionButtons}
          </div>
        </div>

        {/* ---------- Mobile sticky stat footer ---------- */}
        <div className="sd-footer">
          <button
            className="sd-footer__summary"
            onClick={() => setStatsSheetOpen(o => !o)}
            aria-expanded={statsSheetOpen}
          >
            <span>{hpOut(stats.hp)} HP</span>
            <span>{stats.damagePerTick} dmg</span>
            <span>{hullDef.cost.ore + draftCost.ore}M {hullDef.cost.credits + draftCost.credits}C</span>
            <span>{upkeepLabel}</span>
            <span aria-hidden>{statsSheetOpen ? '▾' : '▴'}</span>
          </button>
          {statsSheetOpen && (
            <div className="sd-footer__sheet">
              <div className="sd-side__stats">{statRows}</div>
              {refitBar}
              {noteLine}
              {error && (
                <button className="sd-error" onClick={() => setError(null)}>⚠ {error}</button>
              )}
              {actionButtons}
            </div>
          )}
          {!statsSheetOpen && (
            <div className="sd-footer__cta">
              <button
                className="sd-btn sd-btn--primary"
                disabled={busy}
                onClick={() => save(true)}
              >
                {selected ? 'SAVE & ACTIVATE' : 'CREATE & ACTIVATE'}
              </button>
            </div>
          )}
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
