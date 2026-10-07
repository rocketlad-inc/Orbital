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
import { useAuth } from '../multiplayer/AuthContext';
import { startCommissionCheckout } from '../multiplayer/api';
import { COMMISSION_NAME, COMMISSION_PRICE, COMMISSION_DISCORD, canBuyHere, logCommission } from '../multiplayer/commission';
import { ShipClassName, BuildableClassName, SHIP_CLASSES, BUILDABLE_CLASSES, upkeepSplitFor } from '../game/shipClasses';
import { deliveredHullHp } from '../game/combat';
import {
  ShipPartId, ALL_PART_IDS, SHIP_PART_DEFS, SHIP_SLOT_COUNTS,
  sanitizeParts, computeDesignStats, partsCost, countPart,
  detonatorDamage, detonatorDisclosure, SERVER_HULL_BASE, PART_GLYPH,
  damageProfile, refitFee, PART_STACK_ESCALATION, reductionPct, reductionLadder,
  hitChanceOf, SERVER_HULL_BASE as HULL_BASE,
} from '../game/shipParts';
import {
  ShipIcon, ShipIconVariant, ALL_VARIANTS, ICON_VARIANT_NAMES, DEFAULT_SHIP_ICONS, PREMIUM_VARIANTS,
} from './ShipIcons';
import type { ShipDesign } from '../types';
import { PART_FEATURE } from '../game/researchUnlocks';
import { useFeatureGate } from '../hooks/useFeatureGate';
import { t, tn, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
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
  if (t.icon_variant && /^[A-Y]$/.test(t.icon_variant)) {
    iv = t.icon_variant as ShipDesign['iconVariant'];
  }
  return {
    id: t.id,
    shipClass: (BUILDABLE_CLASSES.includes(t.ship_class as BuildableClassName)
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
  if (d.icon_variant && /^[A-Y]$/.test(d.icon_variant)) {
    iv = d.icon_variant as ShipDesign['iconVariant'];
  }
  return {
    id: d.id,
    shipClass: (BUILDABLE_CLASSES.includes(d.ship_class as BuildableClassName)
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
function counterText(pid: ShipPartId): string | undefined {
  switch (pid) {
    case 'kinetic': return t('ship.sd.counter.kinetic');
    case 'energy': return t('ship.sd.counter.energy');
    case 'shield': return t('ship.sd.counter.shield');
    case 'armor': return t('ship.sd.counter.armor');
    default: return undefined;
  }
}

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
  useI18n();
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();
  useEffect(() => { logUiEvent(mpActions?.gameId, 'ship-designer'); }, [mpActions?.gameId]);
  const gate = useFeatureGate();

  // The designer only ever edits hulls a yard can make. Capital hulls
  // have no fittings and no shipyard path, so they are not a tab here.
  const [activeClass, setActiveClass] = useState<BuildableClassName>(
    (initialClass as BuildableClassName) ?? 'corvette',
  );
  // Fresh server copy after a mutation; null = use the /state mirror.
  const [freshDesigns, setFreshDesigns] = useState<ShipDesign[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftParts, setDraftParts] = useState<ShipPartId[]>([]);
  const [draftIcon, setDraftIcon] = useState<ShipIconVariant | undefined>(undefined);
  const [iconMenuOpen, setIconMenuOpen] = useState(false);
  // A Commission line shown on the avatar for a look, never saved: the
  // design keeps draftIcon, and the save paths never read this. Showing
  // the goods on the player's own hull is the whole pitch (insight
  // report, idea 1); the server would refuse to persist it anyway.
  const [previewIcon, setPreviewIcon] = useState<ShipIconVariant | undefined>(undefined);
  // Commission gate for the J-S icon lines. UI-only — the designer save
  // and the build queue both re-check the entitlement server-side.
  const { user } = useAuth();
  const isPremium = !!user?.is_premium;
  const iconDropdownRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Cross-game template library. null = still loading. */
  const [templates, setTemplates] = useState<ShipTemplate[] | null>(null);
  /** Loadouts from this account's OTHER games. Saving to the template
   *  library is opt-in and almost nobody does it — 313 in-game designs
   *  against 17 player-made templates across every live game — so a
   *  player arrived in a new match with a builder that looked empty
   *  even though they had spent a whole game refining loadouts. */
  const [pastDesigns, setPastDesigns] = useState<
    Array<ShipTemplate & { gameName: string | null }> | null
  >(null);
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
      if (!mpActions) { setTemplates([]); setPastDesigns([]); return; }
      const rows = await mpActions.getShipTemplates();
      if (!cancelled && rows) setTemplates(rows.map(serverTemplateToClient));
      const past = await mpActions.getPastDesigns();
      if (!cancelled) {
        setPastDesigns((past ?? []).map(d => ({
          ...serverTemplateToClient(d),
          gameName: d.game_name,
        })));
      }
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
  const classPastDesigns = useMemo(
    () => (pastDesigns ?? []).filter(t => t.shipClass === activeClass),
    [pastDesigns, activeClass],
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
  const draftCost = partsCost(draftParts, activeClass);
  // The build discount belongs on "Cost / ship" too. Without it, this
  // panel quotes 36M/18C for a design the yard actually builds for 24M/12C
  // once the Construction discount (or a senate law) is folded in -- the
  // designer and the build menu then show two different prices for the
  // same ship, which is exactly the "economy is confusing" complaint. Same
  // arithmetic as the build card and worker/actions.js: scale THEN ceil the
  // summed total, so quote == charge.
  const costMult = gameState.buildCost?.mult ?? 1;
  const priced = (n: number) => Math.ceil(n * costMult);
  const costNote = costMult !== 1
    ? t('ship.sd.costNote', { mult: costMult.toFixed(2) })
    : undefined;
  const nDetonators = countPart(draftParts, 'detonator');
  const upkeepMult = gameState.fleetUpkeep?.multiplier ?? 1;
  // Upkeep currency follows the DRAFT loadout, so the number moves as
  // you fit parts — that responsiveness is the point of the feature.
  const upkeep = upkeepSplitFor(activeClass, draftParts, partsCost);
  const upkeepLabel = (upkeep.credits * upkeepMult) > 0 || (upkeep.ore * upkeepMult) > 0
    ? [
        upkeep.credits * upkeepMult > 0 ? `${(upkeep.credits * upkeepMult).toFixed(2).replace(/\.?0+$/, '')}C` : null,
        upkeep.ore * upkeepMult > 0 ? `${(upkeep.ore * upkeepMult).toFixed(2).replace(/\.?0+$/, '')}M` : null,
      ].filter(Boolean).join(' + ') + ` ${t('ship.sd.perTick')}`
    : t('ship.sd.free');

  // Combat-profile readout: what this hull deals and what it shrugs off.
  const nKinetic = countPart(draftParts, 'kinetic');
  const nEnergy = countPart(draftParts, 'energy');
  const nShields = countPart(draftParts, 'shield');
  const nArmor = countPart(draftParts, 'armor');
  const prof = damageProfile(draftParts);
  const dmgTypeLabel = nKinetic + nEnergy === 0
    ? t('ship.sd.dmgKineticBare')
    : nEnergy === 0 ? t('ship.sd.dmgKinetic')
    : nKinetic === 0 ? t('ship.sd.dmgEnergy')
    : `⚔ ${Math.round(prof.kinetic * 100)}% / ⚡ ${Math.round(prof.energy * 100)}%`;
  const defLabel = nShields === 0 && nArmor === 0
    ? t('ship.sd.unshielded')
    : [nShields > 0 ? t('ship.sd.shieldsVsKinetic', { n: nShields }) : '', nArmor > 0 ? t('ship.sd.armorVsEnergy', { n: nArmor }) : '']
        .filter(Boolean).join(' · ');
  // The old hint said "strong vs armored targets", which read as a damage
  // BONUS. There is none: defenseMitigation only ever reduces, so the
  // off-counter simply arrives at 100%. Both lines below quote the real
  // multiplier, and the incoming line quotes THIS draft's actual stack.
  const outgoingHint = (() => {
    if (nKinetic > 0 && nEnergy > 0) return t('ship.sd.hintMixed');
    if (nKinetic > 0) return t('ship.sd.hintKinetic');
    if (nEnergy > 0) return t('ship.sd.hintEnergy');
    return '';
  })();
  const incomingHint = (() => {
    if (nShields === 0 && nArmor === 0) return t('ship.sd.hintNoDefense');
    const kin = nShields > 0
      ? t('ship.sd.kinReduced', { pct: reductionPct(nShields) })
      : t('ship.sd.kinUnreduced');
    const nrg = nArmor > 0
      ? t('ship.sd.nrgReduced', { pct: reductionPct(nArmor) })
      : t('ship.sd.nrgUnreduced');
    return t('ship.sd.incoming', { kin, nrg });
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
      const fee = refitFee(cur, target, activeClass);
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
    setPreviewIcon(undefined);
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
    if (!name) { setError(t('ship.sd.nameFirst')); return; }
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

  const switchClass = (cls: BuildableClassName) => {
    setActiveClass(cls);
    setPreviewIcon(undefined);
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
    if (lock) return t('ship.sd.partLocked', { name: SHIP_PART_DEFS[pid].name, reason: lock.text });
    // Replacing a filled socket frees its slot, so only a fit into an
    // EMPTY socket can overflow.
    const replacing = slotIdx != null && draftParts[slotIdx] != null;
    if (!replacing && draftParts.length >= slots) {
      return t('ship.sd.slotsFull', { n: slots });
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
      setRefitNote(t('ship.sd.nowActive', { name }));
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
    if (!res.ok) { setError(res.error ?? t('ship.sd.refitFailed')); return; }
    const done = res.refitted?.length ?? 0;
    const pend = res.pending?.length ?? 0;
    const cost = res.charged;
    setRefitNote(
      tn('ship.sd.refittedNow', done)
      + (cost && (cost.ore > 0 || cost.credits > 0) ? ` ${t('ship.sd.refitFor', { ore: cost.ore, credits: cost.credits })}` : '')
      + (pend > 0 ? ` · ${t('ship.sd.refitPending', { n: pend })}` : '')
      + '.',
    );
  };

  // MP-only feature — GameUI already gates the mount, but be defensive.
  if (!mpActions) return null;

  const iconVariant = draftIcon ?? DEFAULT_SHIP_ICONS[activeClass];
  // Only a line this account cannot save is previewed; switching hull
  // class leaves the preview behind (its name belongs to the old class).
  const shownIcon = previewIcon ?? iconVariant;
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
        <span className="sd-stat__label">{t('ship.sd.maxHp')}</span>
        <span className="sd-stat__value"><Delta from={hpOut(base.hp)} to={hpOut(stats.hp)} /></span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">{t('ship.sd.dmgVolley')}</span>
        <span className="sd-stat__value"><Delta from={base.damagePerTick} to={stats.damagePerTick} /></span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">{t('ship.sd.speed')}</span>
        <span className="sd-stat__value"><Delta from={base.speed} to={stats.speed} /></span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">{t('ship.sd.dmgType')}</span>
        <span className="sd-stat__value">{dmgTypeLabel}</span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">{t('ship.sd.defense')}</span>
        <span className="sd-stat__value">{defLabel}</span>
      </div>
      {/* ONE travel time, the one the ship will fly. This panel showed two
          rows both labelled "Travel time": the hull's speed class (0.59x
          for a corvette) and the engine parts (x1.00 with none). Only the
          ENGINE number is real in multiplayer — every launch asks
          fleetPace.shipEngineAccel (faction g x tech x engine parts); the
          speed-class multiplier is read only by the frozen single-player
          sim. Speed (above) is combat speed: evasion and hit chance.
          A hull in a fleet also flies at the fleet's slowest pace. */}
      <div className="sd-stat" title={t('ship.sd.travelTip')}>
        <span className="sd-stat__label">{t('ship.sd.travel')}</span>
        <span className="sd-stat__value">
          <Delta from={base.travelTimeMult} to={stats.travelTimeMult} fmt={n => `×${n.toFixed(2)}`} invert />
        </span>
      </div>
      <div className="sd-stat" title={costNote}>
        <span className="sd-stat__label">{t('ship.sd.costShip')}</span>
        <span className="sd-stat__value">
          <Delta
            from={priced(base.totalCost.ore)} to={priced(hullDef.cost.ore + draftCost.ore)}
            fmt={n => `${n}M`} invert
          />
          {' '}
          <Delta
            from={priced(base.totalCost.credits)} to={priced(hullDef.cost.credits + draftCost.credits)}
            fmt={n => `${n}C`} invert
          />
        </span>
      </div>
      <div className="sd-stat">
        <span className="sd-stat__label">{t('ship.sd.upkeep')}</span>
        <span className="sd-stat__value">{upkeepLabel}</span>
      </div>
      {nDetonators > 0 && (
        <div className="sd-stat">
          <span className="sd-stat__label">{t('ship.sd.detonation')}</span>
          <span className="sd-stat__value" style={{ color: '#ff5e5e' }}>{t('ship.sd.dmgN', { n: detDamage })}</span>
        </div>
      )}
    </>
  );

  const refitBar = selected && refitInfo && (refitInfo.hulls > 0 || refitInfo.pendingAlready > 0) && (
    <div className="sd-refit">
      {refitInfo.hulls > 0 ? (
        <>
          <div className="sd-refit__line">
            {tn('ship.sd.liveDiffer', refitInfo.hulls)}
            {refitInfo.pendingAlready > 0 && <> · {t('ship.sd.alreadyPending', { n: refitInfo.pendingAlready })}</>}
          </div>
          <button
            className="sd-btn sd-btn--refit"
            disabled={busy || !draftMatchesSelected}
            onClick={doRefitFleet}
            title={draftMatchesSelected
              ? t('ship.sd.refitTip')
              : t('ship.sd.refitSaveFirstTip')}
          >
            {t('ship.sd.refitFleet', { ore: refitInfo.ore, credits: refitInfo.credits })}
          </button>
          {!draftMatchesSelected && (
            <div className="sd-refit__hint">{t('ship.sd.unsavedEdits')}</div>
          )}
          <div className="sd-refit__hint">
            {t('ship.sd.refitFee')}
          </div>
        </>
      ) : (
        <div className="sd-refit__line">
          {tn('ship.sd.pendingRefit', refitInfo.pendingAlready)}
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
        title={t('ship.sd.saveActiveTip')}
      >
        {selected ? t('ship.sd.saveActive') : t('ship.sd.createActive')}
      </button>
      <button
        className="sd-btn"
        disabled={busy}
        onClick={() => save(false)}
        title={t('ship.sd.saveTip')}
      >
        {selected ? t('ship.sd.save') : t('ship.sd.create')}
      </button>
      <button
        className="sd-btn"
        disabled={busy}
        onClick={saveAsTemplate}
        title={t('ship.sd.saveTemplateTip')}
      >
        {t('ship.sd.saveTemplate')}
      </button>
      {selected && (
        <button
          className="sd-btn sd-btn--danger"
          disabled={busy}
          onClick={() => deleteDesign(selected)}
        >
          {t('ship.sd.delete')}
        </button>
      )}
    </div>
  );

  return (
    <div className="ship-designer-overlay" onClick={onClose}>
      <div className="sd" onClick={e => e.stopPropagation()}>
        {/* ---------- Header: title + class tabs + close ---------- */}
        <div className="sd-header">
          <span className="sd-title">{t('ship.sd.title')}</span>
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
          <button className="sd-close" onClick={onClose} aria-label={t('ship.sd.close')}>✕</button>
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
                {libraryOpen ? '▾' : '▸'} {t('ship.sd.library')}
                <span className="sd-library__meta">
                  {tn('ship.sd.designs', classDesigns.length)}
                  {activeDesignForClass ? ` · ${t('ship.sd.activeName', { name: activeDesignForClass.name })}` : ` · ${t('ship.sd.buildsBare')}`}
                </span>
              </button>
              {libraryOpen && (
                <div className="sd-library__body">
                  {classDesigns.length === 0 && (
                    <div className="sd-hint">
                      {t('ship.sd.noDesigns')}
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
                          {d.parts.length === 0 ? t('ship.sd.bareHull') : d.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                        </span>
                      </span>
                      {d.isActive ? (
                        <>
                          <span className="sd-badge" title={t('ship.sd.activeBadgeTip')}>{t('ship.sd.active')}</span>
                          <button
                            className="sd-mini-btn"
                            disabled={busy}
                            onClick={e => { e.stopPropagation(); setActiveDesign(d, false); }}
                            title={t('ship.sd.unsetTip')}
                          >{t('ship.sd.unset')}</button>
                        </>
                      ) : (
                        <button
                          className="sd-mini-btn"
                          disabled={busy}
                          onClick={e => { e.stopPropagation(); setActiveDesign(d, true); }}
                          title={t('ship.sd.setActiveTip')}
                        >{t('ship.sd.setActive')}</button>
                      )}
                      <button
                        className="sd-mini-btn sd-mini-btn--danger"
                        disabled={busy}
                        onClick={e => { e.stopPropagation(); deleteDesign(d); }}
                        title={t('ship.sd.deleteDesignTip')}
                      >✕</button>
                    </div>
                  ))}
                  <div className="sd-library__subhead">{t('ship.sd.templatesHead')}</div>
                  {templates === null ? (
                    <div className="sd-hint">{t('ship.sd.loadingTemplates')}</div>
                  ) : classTemplates.length === 0 ? (
                    <div className="sd-hint">
                      {t('ship.sd.noTemplates')}
                    </div>
                  ) : classTemplates.map(tpl => (
                    <div key={tpl.id} className="sd-library__row">
                      <ShipIcon shipClass={activeClass} variant={tpl.iconVariant} size={16} />
                      <span className="sd-library__row-name">
                        {tpl.name}
                        <span className="sd-library__row-parts">
                          {tpl.parts.length === 0 ? t('ship.sd.bareHull') : tpl.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                        </span>
                      </span>
                      <button className="sd-mini-btn" disabled={busy} onClick={() => loadTemplate(tpl)} title={t('ship.sd.loadTip')}>{t('ship.sd.load')}</button>
                      <button className="sd-mini-btn sd-mini-btn--danger" disabled={busy} onClick={() => deleteTemplate(tpl)} title={t('ship.sd.deleteTemplateTip')}>✕</button>
                    </div>
                  ))}

                  {/* Loadouts from your other games. Read-only: LOAD drops
                      one into the editor and SAVE runs the ordinary create
                      path, so this game's tech still decides what fits. */}
                  {classPastDesigns.length > 0 && (
                    <>
                      <div className="sd-library__subhead">{t('ship.sd.otherGames')}</div>
                      {classPastDesigns.map(tpl => (
                        <div key={tpl.id} className="sd-library__row">
                          <ShipIcon shipClass={activeClass} variant={tpl.iconVariant} size={16} />
                          <span className="sd-library__row-name">
                            {tpl.name}
                            <span className="sd-library__row-parts">
                              {tpl.parts.length === 0
                                ? t('ship.sd.bareHull')
                                : tpl.parts.map(p => PART_GLYPH[p as ShipPartId] ?? '?').join(' ')}
                              {tpl.gameName ? ` · ${tpl.gameName}` : ''}
                            </span>
                          </span>
                          <button
                            className="sd-mini-btn"
                            disabled={busy}
                            onClick={() => loadTemplate(tpl)}
                            title={t('ship.sd.loadTip')}
                          >{t('ship.sd.load')}</button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Name + icon row */}
            <div className="sd-name-row">
              <input
                className="sd-name-input"
                placeholder={selected ? selected.name : t('ship.sd.namePlaceholder')}
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
                  title={t('ship.sd.changeIcon')}
                >
                  <ShipIcon shipClass={activeClass} variant={iconVariant} size={18} />
                  <span className="sd-icon-caret" aria-hidden>▾</span>
                </button>
                {iconMenuOpen && (
                  <div className="sd-icon-menu" role="listbox" aria-label={t('ship.sd.shipIcon')}>
                    {ALL_VARIANTS.map(v => {
                      const isDefault = v === DEFAULT_SHIP_ICONS[activeClass];
                      // Premium lines render for everyone — locked, not
                      // hidden; the hull you can see but not fly is the ad.
                      // Clicking one PREVIEWS it on the avatar (not saved).
                      const locked = !isPremium && PREMIUM_VARIANTS.has(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          role="option"
                          aria-selected={v === iconVariant}
                          className={`sd-icon-option ${v === iconVariant ? 'selected' : ''} ${locked ? 'is-locked' : ''}`}
                          title={locked
                            ? t('ship.sd.previewLineTip', { line: ICON_VARIANT_NAMES[activeClass][v], commission: tk('mp.commission.name', COMMISSION_NAME) })
                            : undefined}
                          onClick={() => {
                            if (locked) {
                              setPreviewIcon(v);
                              logCommission('designer', 'view');
                            } else {
                              setDraftIcon(v);
                              setPreviewIcon(undefined);
                            }
                            setIconMenuOpen(false);
                          }}
                        >
                          <ShipIcon shipClass={activeClass} variant={v} size={22} />
                          <span>
                            {ICON_VARIANT_NAMES[activeClass][v]}
                            {isDefault && <span className="sd-icon-default"> · {t('ship.sd.default')}</span>}
                            {locked && <span aria-hidden> 🔒</span>}
                          </span>
                          {v === iconVariant && <span aria-hidden>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {selected && (
                <button className="sd-mini-btn" onClick={() => loadDesign(null)}>{t('ship.sd.newDesign')}</button>
              )}
            </div>

            {/* ---------- THE CANVAS: avatar + socket ring ---------- */}
            <div className={`sd-canvas ${dragging ? 'sd-canvas--dragging' : ''}`} data-tutorial-id="designer-canvas">
              <div className="sd-canvas__avatar">
                {/* Component avatar: the portrait physically grows the
                    fitted hardware (barrel, emitter, plating, plume,
                    shield bubble) — live, as parts land in sockets. */}
                <ShipIcon shipClass={activeClass} variant={shownIcon} size={96} parts={draftParts} />
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
                      ? t('ship.sd.unfitTip', { name: SHIP_PART_DEFS[part].name })
                      : t('ship.sd.emptySlotTip')}
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
                {t('ship.sd.slotsLabel', { used: draftParts.length, slots })}
              </div>
              {!dragHintSeen && draftParts.length === 0 && slots > 0 && (
                <div className="sd-drag-hint" aria-hidden>
                  {t('ship.sd.dragHint')}
                </div>
              )}
              {flash && <div className="sd-flash" role="alert">⚠ {flash}</div>}
              {nDetonators > 0 && (
                <div className="sd-canvas__det-warning">⚠ {detonatorDisclosure(detDamage)}</div>
              )}
              {previewIcon && (
                <div className="sd-preview" role="status">
                  <span>
                    {t('ship.sd.previewA')} <b>{ICON_VARIANT_NAMES[activeClass][previewIcon]}</b>{t('ship.sd.previewB', { commission: tk('mp.commission.name', COMMISSION_NAME), discord: tk('mp.commission.discord', COMMISSION_DISCORD) })}
                  </span>
                  {canBuyHere() && (
                    <button
                      type="button"
                      className="sd-preview__get"
                      onClick={() => {
                        logCommission('designer', 'click');
                        void startCommissionCheckout('designer').then(url => { if (url) window.location.assign(url); });
                      }}
                    >{t('ship.sd.getIt', { price: tk('mp.commission.price', COMMISSION_PRICE) })}</button>
                  )}
                  <button type="button" className="sd-preview__end" onClick={() => setPreviewIcon(undefined)}>
                    {t('ship.sd.endPreview')}
                  </button>
                </div>
              )}
            </div>

            {/* ---------- Palette drawer ---------- */}
            <div className={`sd-drawer ${drawerOpen ? 'open' : ''}`}>
              <button
                className="sd-drawer__toggle"
                onClick={() => setDrawerOpen(o => !o)}
                aria-expanded={drawerOpen}
              >
                {drawerOpen ? '▾' : '▴'} {t('ship.sd.parts')}
                {activeClass === 'freighter' && (
                  <span className="sd-drawer__hint">{t('ship.sd.freighterHint')}</span>
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
                        onClick={() => { if (!lock) fitPart(pid); else showFlash(t('ship.sd.partLockedShort', { name: def.name, reason: lock.text })); }}
                        title={`${def.blurb}\n${def.techNote}${lock ? `\n🔒 ${lock.text}` : ''}\n${t('ship.sd.clickToFit')}`}
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
                          {counterText(pid) && (
                            <span className="sd-part__counter">{t('ship.sd.countered', { text: counterText(pid) ?? '' })}</span>
                          )}
                          {isDet && (
                            <span className="sd-part__counter" style={{ color: '#ff8a5c' }}>
                              {t('ship.sd.detWarn')}
                            </span>
                          )}
                        </span>
                        <span className="sd-part__price" title={n > 0 ? t('ship.sd.escalateTip', { mult: PART_STACK_ESCALATION }) : t('ship.sd.basePrice')}>
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
              {selected ? t('ship.sd.editing', { name: selected.name }) : t('ship.sd.newTitle')}
              {selected && !draftMatchesSelected && <span className="sd-side__dirty"> · {t('ship.sd.unsaved')}</span>}
            </div>
            <div className="sd-side__stats">{statRows}</div>
            {/* COMBAT V2's core rule, live. A player fitting an engine watches
                these numbers move and learns the whole system without reading
                a word of documentation — which matters because animations are
                unchanged, so a hit and a miss look identical on the map. This
                is the only place the rule is stated. */}
            <div className="sd-hit">
              <div className="sd-hit__title">{t('ship.sd.hitTitle')}</div>
              <div className="sd-hit__row">
                {(['corvette', 'frigate', 'destroyer'] as ShipClassName[]).map(hc => {
                  const p = hitChanceOf(stats.speed, HULL_BASE[hc].speed);
                  return (
                    <div key={hc} className="sd-hit__cell" title={t('ship.sd.vsBare', { cls: hc, speed: HULL_BASE[hc].speed })}>
                      <span className="sd-hit__glyph">{hc === 'corvette' ? '▹' : hc === 'frigate' ? '▰' : '▮'}</span>
                      <span className="sd-hit__pct">{(100 * p).toFixed(0)}%</span>
                      <span className="sd-hit__lbl">{t(`ship.sd.abbr.${hc as 'corvette' | 'frigate' | 'destroyer'}` as const)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="sd-hit__foot">
                {t('ship.sd.hitFoot')}
              </div>
            </div>
            {outgoingHint && <div className="sd-hint sd-hint--matchup">{outgoingHint}</div>}
            <div className="sd-hint sd-hint--matchup">{incomingHint}</div>
            <div className="sd-hint">
              <strong>{t('ship.sd.tipShields')}</strong>{' '}{t('ship.sd.tipA')}{' '}
              <strong>{t('ship.sd.tipArmor')}</strong>{' '}{t('ship.sd.tipB')}{' '}
              <em>{t('ship.sd.tipCompound')}</em>{' '}
              {t('ship.sd.tipC', { ladder: reductionLadder(3), hp: SERVER_HULL_BASE[activeClass].hp, dmg: SERVER_HULL_BASE[activeClass].damagePerTick })}
              {hpOut(100) !== 100 && (
                <> {t('ship.sd.tipTech', { mult: (hpOut(1000) / 1000).toFixed(2) })}</>
              )}
              {' '}{t('ship.sd.tipBuilds')}
            </div>
            {refitBar}
            {noteLine}
            {error && (
              <button className="sd-error" onClick={() => setError(null)} title={t('ship.sd.dismiss')}>
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
            <span>{t('ship.sd.dmgN', { n: stats.damagePerTick })}</span>
            <span>{priced(hullDef.cost.ore + draftCost.ore)}M {priced(hullDef.cost.credits + draftCost.credits)}C</span>
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
                {selected ? t('ship.sd.saveActivate') : t('ship.sd.createActivate')}
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
