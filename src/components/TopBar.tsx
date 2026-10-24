// ============================================================
// TopBar — persistent top strip
// Title | Resources | Nav buttons | Time / Sim controls | Alerts
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { NotificationSettingsModal } from '../multiplayer/NotificationSettings';
import { isLightweight, setLightweight, subscribeLightweight } from '../render/lightweightMode';
import { useGameContext } from '../state/gameContext';
import {
  TICK_SPEED_OPTIONS, DayNight, DEFAULT_DAY_NIGHT, COMMON_ZONES,
  dayNightOf, scheduleOf, inDay, ticksOfDay, localMinutes, clockLabel, untilLabel,
  describeSchedule, localTimeZone, zoneLabel, speedLabel,
} from '../game/tickSchedule';
import { useTurnBasedSettings } from '../state/turnBasedSettings';
import { computeTurnBudget } from '../game/turnBudget';
import { useAuth } from '../multiplayer/AuthContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { useMpTurnStatus } from '../multiplayer/useMpTurnStatus';
import { logger } from '../game/logger';
import { SaveLoadModal } from './SaveLoadModal';
import { AdminGrantModal } from './AdminGrantModal';
import { computeIncomePerTick } from '../game/settlements';
import { TECH_DEFS, nextLevelCost, TECH_MAX_LEVEL, type TechId } from '../game/techs';
import { useTutorial } from '../state/tutorial';
import { TUTORIAL_STEP_COUNT, TRIAL_TUTORIAL_STEP_COUNT } from '../game/tutorialSteps';
import type { GameState } from '../types';
import { displayResource } from '../game/formatResources';
import { GameDetail } from '../multiplayer/AdminAnalytics';
import '../multiplayer/AdminAnalytics.css';
import './TopBar.css';
import { GIT_SHA } from '../_version';
import { useIsMobile, isInApp } from '../hooks/useIsMobile';
import { saveTextFile } from '../platform/saveTextFile';
import { t, tn } from '../i18n/core';
import { useI18n, LanguageSwitch } from '../i18n/react';
import { saveLocale } from '../i18n/account';
import { inLang } from '../i18n/serverText';
import { SoloClock, soloSpeedLabel, nextSoloSpeed } from '../multiplayer/SoloClock';
import { openSaveEmpire } from '../multiplayer/trial/SaveEmpire';
import '../multiplayer/trial/trial.css';

export type PanelId = 'settlements' | 'fleet' | 'research' | null;

interface TopBarProps {
  activePanel: PanelId;
  onTogglePanel: (panel: PanelId) => void;
  onExitMode?: () => void;
  /** Hide sim-speed buttons and tick-skip controls. Used in multiplayer:
   *  the server dictates the tick rate set in the lobby, players can't
   *  fast-forward or skip locally. */
  hideSimControls?: boolean;
  /** Room/game id for the side-menu admin section (host-only). When set
   *  and isHost is true, the menu shows Force-Tick controls. */
  adminGameId?: string | null;
  isHost?: boolean;
  /** True when the SideMenu should offer Save/Load entries. Single-player
   *  only — MP saves are server-side and out of scope. */
  canSaveLoad?: boolean;
  /** Threaded down from SinglePlayerView so the Load picker can hand the
   *  deserialized state back to the parent, which remounts GameContextProvider. */
  onLoadSave?: (state: GameState) => void;
}

const SIM_SPEEDS = [1, 10, 100, 1000, 10000, 100000];

export const TopBar: React.FC<TopBarProps> = ({
  activePanel, onTogglePanel, onExitMode, hideSimControls = false,
  adminGameId = null, isHost = false,
  canSaveLoad = false, onLoadSave,
}) => {
  useI18n();
  const {
    gameState, simSpeed, setSimSpeed, updateTick,
    turnBasedActive, commitTurn,
  } = useGameContext();
  // MP turn status: only present when wrapped in MultiplayerActionsProvider.
  // Drives the MP-flavored COMMIT TURN UI (waiting-on banner, server commit
  // call, ready/needed badge). In SP this returns null and we fall through
  // to the local TBM path below.
  const mpActions = useMultiplayerActions();
  const { status: mpTurnStatus, refresh: refreshTurnStatus } = useMpTurnStatus();
  const mpTbmActive = !!mpTurnStatus?.turn_based_enabled;
  const { user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  // Account-level dialog. Owned by TopBar, not SideMenu, so closing the
  // drawer doesn't also dismiss the dialog it opened.
  const [notifOpen, setNotifOpen] = useState(false);
  // Save / Load modal state. Lifted into TopBar (rather than SideMenu)
  // because closing the menu shouldn't kill the modal — players want to
  // see the picker without the menu also occupying the screen.
  const [saveLoadMode, setSaveLoadMode] = useState<null | 'save' | 'load'>(null);
  // Admin resource-grant modal — opened from the DEBUG section of the
  // SideMenu. SP-always-visible; MP-host-only on the server side.
  const [adminGrantOpen, setAdminGrantOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  // Esc closes the drawer
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const playerResources = gameState.resources['player'];
  const playerShips = useMemo(
    () => gameState.ships.filter(s => s.ownedBy === 'player'),
    [gameState.ships]
  );

  // Per-tick income for the resource pill subtext. Splits "delivered"
  // (settlements with a freighter parked = actually reaches the pool)
  // from "stranded" (no freighter = stockpiling at the settlement, not
  // landing in CR). The stranded count is surfaced as a hover hint so
  // the player knows *why* their gold pile isn't moving.
  const income = useMemo(() => {
    const lvl = gameState.factionTech?.player?.levels?.industry ?? 0;
    const yieldMul = 1 + TECH_DEFS.industry.perLevel * lvl;
    // Senate yield laws are part of what the tick will credit, so the
    // quoted rate has to include them or a passed law reads as inert.
    const sl = gameState.activeSliders;
    return computeIncomePerTick(
      'player',
      gameState.settlements,
      gameState.bodies,
      gameState.ships,
      yieldMul,
      sl && {
        metal: sl.metalYieldMultiplier,
        credits: sl.goldYieldMultiplier,
        science: sl.scienceYieldMultiplier,
      },
    );
  }, [gameState.settlements, gameState.bodies, gameState.ships, gameState.factionTech, gameState.activeSliders]);

  // The alert-chip derivation that used to live here (recent combat events,
  // ships arriving soon, low-fuel ships) is gone — both the EventLog dock
  // panel (full chronicle) and the SituationLog dock panel (arrivals + low
  // fuel + every other attention category) cover the same ground without
  // crowding the top bar. extractPrimaryName / logEntryIcon / hexToRgba /
  // alertFromLogEntry / AlertDetailsModal / EventLogPanel moved into
  // src/components/EventLog.tsx with the panel itself.

  const handleSkip = (n: number) => updateTick(gameState.currentTick + n);

  const tickStr = `T+${Math.floor(gameState.currentTick)}`;

  // Live "next tick in Ns" countdown. The server stamps nextTickAt (epoch
  // ms) on every /state; we tick a local clock 4×/sec to animate the
  // remaining time down. Multiplayer only — single-player has no
  // server-driven cadence (nextTickAt is undefined) and shows the sim-speed
  // controls instead.
  const nextTickAt = gameState.nextTickAt;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (nextTickAt == null) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [nextTickAt]);
  // Clamp to [0, interval] so clock skew can't show a negative or absurd
  // value; round up so it counts 3→2→1 and only hits 0 right at the tick.
  const tickCountdown = nextTickAt == null
    ? null
    : Math.max(0, Math.min(
        gameState.tickIntervalMs != null ? gameState.tickIntervalMs / 1000 : Infinity,
        Math.ceil((nextTickAt - nowMs) / 100) / 10,
      ));
  // Format as whole units (Xh Ym / Xm Ys / Xs) so it reads cleanly and
  // ticks down a visible step every second at any interval — a raw
  // "3600.0s" looked frozen. ceil so it counts N→…→1→0 and only shows 0
  // right at the tick. Width is held steady by .time-display's min-width
  // (the box must not grow/shrink as the digits change).
  const tickCountdownLabel = tickCountdown == null
    ? null
    : (() => {
        const total = Math.ceil(tickCountdown);
        const pad = (n: number) => String(n).padStart(2, '0');
        if (total >= 3600) {
          return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
        }
        if (total >= 60) {
          return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
        }
        return `${total}s`;
      })();

  return (
    <div className={`top-bar${gameState.solo ? ' top-bar--solo' : ''}`}>
      <button
        className="top-bar__title"
        onClick={() => setMenuOpen(true)}
        title={t('topbar.openMenu')}
        aria-label={t('topbar.openMenu')}
        data-tutorial-id="menu-button"
      >
        <div className="top-bar__title-main">ORBITAL{user?.shadow && <span className="trial-dot" aria-hidden="true" />}</div>
        <div className="top-bar__title-sub" title={t('topbar.build', { sha: GIT_SHA })}>v0.3 · {GIT_SHA.slice(0,7)}</div>
      </button>

      {notifOpen && <NotificationSettingsModal onClose={() => setNotifOpen(false)} />}

      {menuOpen && (
        <SideMenu
          onClose={() => setMenuOpen(false)}
          onExitMode={onExitMode}
          user={user}
          onSignOut={signOut}
          onOpenNotifications={() => setNotifOpen(true)}
          adminGameId={adminGameId}
          // A solo game's clock is the SoloClock's (pause, step, speed):
          // the multiplayer host's admin controls would fight it.
          isHost={isHost && !gameState.solo}
          activePanel={activePanel}
          onTogglePanel={onTogglePanel}
          playerShipCount={playerShips.length}
          settlementCount={gameState.settlements.filter(s => s.ownedBy === 'player').length}
          researchTotal={(() => {
            const lvls = gameState.factionTech?.player?.levels || {};
            return Object.values(lvls).reduce((s, n) => s + (n ?? 0), 0);
          })()}
          canSaveLoad={canSaveLoad}
          onOpenSave={() => { setSaveLoadMode('save'); setMenuOpen(false); }}
          onOpenLoad={() => { setSaveLoadMode('load'); setMenuOpen(false); }}
          onOpenAdminGrant={() => { setAdminGrantOpen(true); setMenuOpen(false); }}
          onOpenAnalytics={() => { setAnalyticsOpen(true); setMenuOpen(false); }}
        />
      )}

      {saveLoadMode && (
        <SaveLoadModal
          mode={saveLoadMode}
          onClose={() => setSaveLoadMode(null)}
          currentState={saveLoadMode === 'save' ? gameState : undefined}
          onLoad={(state) => {
            // Close before handing the state back — onLoadSave triggers
            // a full GameContextProvider remount and we don't want a
            // dangling modal on the freshly-loaded session.
            setSaveLoadMode(null);
            onLoadSave?.(state);
          }}
        />
      )}

      {adminGrantOpen && (
        <AdminGrantModal
          onClose={() => setAdminGrantOpen(false)}
          mpGameId={adminGameId}
        />
      )}

      {/* Analytics for THIS match, over the board. Reaching it used to mean
          leaving the game for the lobby, opening the admin tab and picking
          the match back out of a list — three steps to answer a question
          about the thing already on screen. */}
      {analyticsOpen && adminGameId && (
        <div className="mp-analytics-overlay" role="dialog" aria-label={t('topbar.analytics.dialog')}>
          <div className="mp-analytics-overlay__bar">
            <span className="mp-analytics-overlay__title">{t('topbar.analytics.title')}</span>
            <button
              className="mp-analytics-overlay__close"
              onClick={() => setAnalyticsOpen(false)}
              aria-label={t('topbar.analytics.close')}
            >✕</button>
          </div>
          <div className="mp-analytics-overlay__body">
            <GameDetail
              gameId={adminGameId}
              onBack={() => setAnalyticsOpen(false)}
              onEnterRoom={() => setAnalyticsOpen(false)}
            />
          </div>
        </div>
      )}

      {playerResources && (
        <div className="top-bar__resources" data-tutorial-id="topbar-resources">
          {/* FUEL pill removed — fuel is dead (DESIGN-identity-economy.md §1.1) */}
          <ResourcePill
            label={t('topbar.res.metal')} modifier="ore"
            value={playerResources.ore}
            rate={income.delivered.ore}
            local={income.local.ore}
            hasCollector={income.hasCollector}
            upkeep={gameState.fleetUpkeep?.ore ?? 0}
          />
          <ResourcePill
            label={t('topbar.res.credits')} modifier="credits"
            value={playerResources.credits}
            rate={income.delivered.credits}
            local={income.local.credits}
            hasCollector={income.hasCollector}
            upkeep={gameState.fleetUpkeep?.credits ?? 0}
          />
          <ResourcePill
            label={t('topbar.res.science')} modifier="science"
            value={playerResources.science}
            rate={income.delivered.science}
            local={income.local.science}
            hasCollector={income.hasCollector}
          />
          <div className="resource-pill resource-pill--ships">
            <div className="resource-pill__label">{t('topbar.res.ships')}</div>
            <div className="resource-pill__value">{playerShips.length}</div>
          </div>
          {/* Terraformed worlds — the "worlds that matter" economy stat
              (DESIGN-terraforming): each routes 100% of yield to pool,
              takes cities, and anchors trade. Hidden when the payload
              predates terraforming (count 0 with no settlements). */}
          {income.terraformedCount > 0 && (
            <div
              className="resource-pill resource-pill--ships"
              title={tn('topbar.terraTitle', income.terraformedCount)}
            >
              <div className="resource-pill__label">{t('topbar.res.terra')}</div>
              <div className="resource-pill__value">{income.terraformedCount}</div>
            </div>
          )}
          {((gameState.fleetArrears?.credits ?? 0) > 0 || (gameState.fleetArrears?.ore ?? 0) > 0) && (
            // Arrears (§1): the fleet is unpaid and fighting at −25%
            // damage. Red pulsing chip — this is a combat debuff, it
            // must be impossible to miss.
            <div
              className="resource-pill resource-pill--arrears"
              title={t('topbar.arrearsTitle', { credits: fmtRate(gameState.fleetArrears?.credits ?? 0), metal: fmtRate(gameState.fleetArrears?.ore ?? 0) })}
              style={{
                background: 'rgba(255, 70, 70, 0.18)',
                border: '1px solid rgba(255, 90, 90, 0.65)',
                animation: 'arrears-pulse 1.6s ease-in-out infinite',
              }}
            >
              <div className="resource-pill__label" style={{ color: '#ff8a8a' }}>{t('topbar.arrears')}</div>
              <div className="resource-pill__value" style={{ color: '#ff8a8a' }}>{t('topbar.arrearsDmg')}</div>
            </div>
          )}
        </div>
      )}

      <div className="top-bar__nav">
        <button
          className={`nav-button ${activePanel === 'settlements' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'settlements' ? null : 'settlements')}
          title={t('topbar.nav.empire')}
          aria-label={t('topbar.nav.empire')}
          data-tutorial-id="nav-settlements"
        >
          <span className="nav-button__icon" aria-hidden>⌂</span>
          <span className="nav-button__label">{t('topbar.nav.empire')}</span>
          <span className="badge">{gameState.settlements.filter(s => s.ownedBy === 'player').length}</span>
        </button>
        <button
          className={`nav-button ${activePanel === 'fleet' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'fleet' ? null : 'fleet')}
          title={t('topbar.nav.fleet')}
          aria-label={t('topbar.nav.fleet')}
          data-tutorial-id="nav-fleet"
        >
          <span className="nav-button__icon" aria-hidden>◈</span>
          <span className="nav-button__label">{t('topbar.nav.fleet')}</span>
          <span className="badge">{playerShips.length}</span>
        </button>
        <button
          className={`nav-button ${activePanel === 'research' ? 'active' : ''}`}
          onClick={() => onTogglePanel(activePanel === 'research' ? null : 'research')}
          title={t('topbar.nav.researchTitle')}
          aria-label={t('topbar.nav.research')}
          data-tutorial-id="nav-research"
        >
          <span className="nav-button__icon" aria-hidden>⚛</span>
          <span className="nav-button__label">{t('topbar.nav.research')}</span>
          {(() => {
            const lvls = gameState.factionTech?.player?.levels || {};
            const total = Object.values(lvls).reduce((s, n) => s + (n ?? 0), 0);
            // Per Ben/Sean: highlight when a tech is affordable so the
            // player notices research opportunities. Green pulsing dot
            // sits next to the level badge.
            const science = gameState.resources?.player?.science ?? 0;
            const techState = gameState.factionTech?.player;
            let affordable = 0;
            if (techState) {
              const levels = techState.levels || {};
              for (const id of Object.keys(TECH_DEFS) as TechId[]) {
                const cur = levels[id] ?? 0;
                if (cur >= TECH_MAX_LEVEL) continue;
                if (nextLevelCost(cur, TECH_DEFS[id]) <= science) affordable++;
              }
            }
            return (
              <>
                {total > 0 && <span className="badge">{total}</span>}
                {affordable > 0 && (
                  <span
                    className="nav-button__attention-dot"
                    title={tn('topbar.nav.affordableTitle', affordable)}
                    aria-label={t('topbar.nav.affordableAria', { n: affordable })}
                  />
                )}
              </>
            );
          })()}
        </button>
      </div>

      {/* LAWS IN FORCE — right of the tick. The senate's whole point is
          that it changes the numbers everyone plays by, and until now
          nothing outside the Senate tab said a law existed: a passed bill
          silently retuned the economy and the player's only clue was that
          their income didn't match their mental model. Wording comes
          pre-rendered from the server (describeSlider) — do NOT re-phrase
          it here; that mirror has drifted twice before.
          Empty renders nothing, so a lawless game keeps the old bar. */}
      {(gameState.activeLaws?.length ?? 0) > 0 && (
        <div className="top-bar__laws" data-testid="topbar-laws"
          title={gameState.activeLaws!.map(inLang).map(l => `${l.name}: ${l.effect}`).join(' · ')}>
          {/* Phones: just the scales and the count, so the tick and its
              countdown always fit (they were pushed off-screen). */}
          <span className="laws-chip__compact" aria-hidden>⚖ {gameState.activeLaws!.length}</span>
          <div className="laws-chip__label">
            {gameState.activeLaws!.length === 1 ? t('topbar.laws.one') : t('topbar.laws.many', { n: gameState.activeLaws!.length })}
          </div>
          <div className="laws-chip__list">
            {gameState.activeLaws!.slice(0, 2).map(inLang).map(l => {
              const left = Math.max(0, Math.ceil(l.untilTick - gameState.currentTick));
              return (
                <div
                  key={l.sliderId}
                  className="laws-chip__row"
                  // Full sentence + topic on hover; the row itself is
                  // clipped to keep the bar's height fixed.
                  title={t('topbar.laws.rowTitle', { topic: l.topic, effect: l.effect, tick: Math.round(l.untilTick) })}
                >
                  <b>{l.name}</b>
                  <span className="laws-chip__effect">{l.effect.replace(/\.$/, '')}</span>
                  <span className="laws-chip__ttl">{left}t</span>
                </div>
              );
            })}
            {gameState.activeLaws!.length > 2 && (
              <div className="laws-chip__row laws-chip__more">
                {t('topbar.laws.more', { n: gameState.activeLaws!.length - 2 })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="top-bar__time">
        <div className={`time-display${tickCountdownLabel != null || gameState.solo?.paused ? ' time-display--ticking' : ''}`}>
          <div className="time-display__label">{t('topbar.tick')}</div>
          <div className="time-display__value">{tickStr}</div>
          {tickCountdownLabel != null && (
            <div className="time-display__countdown" title={t('topbar.nextTickTitle')}>
              {t('topbar.nextIn', { when: tickCountdownLabel })}
              <TickSpeedChip />
            </div>
          )}
          {/* A paused solo game has no next tick: say so where it was. */}
          {tickCountdownLabel == null && gameState.solo?.paused && (
            <div className="time-display__countdown solo-paused">{t('solo.paused')}</div>
          )}
        </div>
        {gameState.solo && mpActions?.gameId && <SoloClock gameId={mpActions.gameId} />}
        {!hideSimControls && !turnBasedActive && !mpTbmActive && (
          // Realtime sim controls. Hidden in Turn-Based Mode (replaced
          // below by the single COMMIT TURN button) and in multiplayer
          // when the server says TBM is on.
          <div className="sim-controls" data-tutorial-id="sim-controls">
            <button
              className={`sim-btn ${simSpeed === 0 ? 'active' : ''}`}
              onClick={() => setSimSpeed(0)}
              title={t('topbar.pause')}
            >⏸</button>
            {SIM_SPEEDS.map(s => (
              <button
                key={s}
                className={`sim-btn ${simSpeed === s ? 'active' : ''}`}
                onClick={() => setSimSpeed(s)}
                title={t('topbar.speed', { n: s })}
              >{s}×</button>
            ))}
            <button className="sim-btn" onClick={() => handleSkip(10)} title={t('topbar.skip', { n: 10 })}>+10</button>
            <button className="sim-btn" onClick={() => handleSkip(100)} title={t('topbar.skip', { n: 100 })}>+100</button>
            <button className="sim-btn" onClick={() => handleSkip(1000)} title={t('topbar.skip', { n: 1000 })}>+1K</button>
          </div>
        )}
        {!hideSimControls && turnBasedActive && !mpTbmActive && (
          // SP Turn-Based Mode: realtime sim is suppressed. COMMIT TURN
          // jumps the sim by ticksPerTurn. The button carries an inline
          // budget summary (planned orders + ships landing) so the
          // player knows roughly what's about to fire.
          <CommitTurnButton onCommit={commitTurn} />
        )}
        {mpTbmActive && (
          // MP Turn-Based Mode. Source of truth is the server's
          // /turn/status poll. COMMIT TURN posts our vote; the sim
          // doesn't advance until every faction has voted.
          <MpCommitTurnButton
            status={mpTurnStatus!}
            onCommit={async () => {
              if (!mpActions) return;
              const res = await mpActions.commitTurn();
              await refreshTurnStatus();
              if (res.advanced) {
                // Server already advanced — the next /state poll picks
                // up the new tick. Could also force a /state refresh
                // here, but the existing 1.5s poll cadence is enough.
              }
            }}
          />
        )}
      </div>

      {/* The alert chips + ☰ Log (N) pill used to live here. The
          chronicle is now its own DockRail panel (EventLog.tsx) and
          the chips were dropped — they crowded the top bar and split
          attention with both the Situation Log + Event Log on the
          rail. The empty .top-bar__alerts div is left as a flex
          spacer so the time controls + MP button keep their existing
          right-edge anchor. */}
      <div className="top-bar__alerts" />
    </div>
  );
};


// ----------------------------------------------------------------
// Resource pill with per-tick income subtext.
//
// Two rate states:
//   - delivered (green +X/t): settlement yield that's actually reaching
//     the pool via your collector network
//   - stranded (red ~X/t):    yield piling up at settlements because
//     the empire has no collector to receive it. The capital starts
//     with one; lose it and the trickle goes red until you rebuild.
// ----------------------------------------------------------------

const fmtRate = (n: number) => {
  if (n === 0) return '0';
  if (n < 0.1) return n.toFixed(2);
  if (n < 10)  return n.toFixed(1);
  return Math.round(n).toString();
};

const ResourcePill: React.FC<{
  label: string;
  modifier: string;          // → css className suffix (ore/credits/science)
  value: number;             // current pool
  rate: number;              // per-tick income arriving in the pool (delivered)
  local: number;             // per-tick income banking to LOCAL settlement stockpiles (90% of non-collector yield)
  hasCollector: boolean;     // does the empire have any collector at all
  /** Fleet upkeep drain on this resource (§1). The headline rate shows
   *  NET (delivered − upkeep) so the real economic picture is visible
   *  BEFORE arrears hit; the popover breaks out the subtraction. */
  upkeep?: number;
}> = ({ label, modifier, value, rate, local, hasCollector, upkeep = 0 }) => {
  useI18n();
  const hasUpkeep = upkeep > 0.001;
  // NET is the number that matters at a glance — income the fleet is
  // eating counts against you every tick whether you look or not.
  const net = rate - upkeep;
  const hasRate = rate > 0.01 || hasUpkeep;
  const hasLocal = local > 0.01;
  const upkeepTip = hasUpkeep ? ` ${t('topbar.pill.upkeepTip', { up: fmtRate(upkeep), net: `${net < 0 ? '−' : '+'}${fmtRate(Math.abs(net))}` })}` : '';
  let tooltip: string;
  if (hasLocal && !hasCollector) {
    tooltip = `${t('topbar.pill.tipLocalOnly', { label, value: displayResource(value), local: fmtRate(local) })}${upkeepTip}`;
  } else if (hasLocal && hasCollector) {
    tooltip = `${t('topbar.pill.tipBoth', { label, value: displayResource(value), rate: fmtRate(rate), local: fmtRate(local) })}${upkeepTip}`;
  } else if (hasRate) {
    tooltip = `${t('topbar.pill.tipRate', { label, value: displayResource(value), rate: fmtRate(rate) })}${upkeepTip}`;
  } else {
    tooltip = t('topbar.pill.tipPlain', { label, value: displayResource(value) });
  }
  // ONE rate line, not two stacked (+ a third for the label). The old
  // 4-line stack (label / value / +net / ~LOCAL) is what made the bar
  // tall + wide. We show the number that matters at a glance — NET
  // delivered rate when a collector is pumping, else the local trickle
  // (your only income without one) — and move the full breakdown into a
  // popover that reveals on hover (desktop) / focus-tap (mobile).
  const primary = hasRate
    ? net >= 0
      ? { txt: `+${fmtRate(net)}/t`, color: '#7fffa1' }
      : { txt: `−${fmtRate(Math.abs(net))}/t`, color: '#ff7a7a' }
    : hasLocal
      ? { txt: `~${fmtRate(local)}/t`, color: '#ffb84d' }
      : null;
  return (
    <div
      className="resource-pill-wrap"
      tabIndex={hasLocal || hasRate ? 0 : undefined}
    >
      <div className={`resource-pill resource-pill--${modifier}`} title={tooltip}>
        <div className="resource-pill__label">{label}</div>
        <div className="resource-pill__value">{displayResource(value)}</div>
        {primary && (
          <div
            className="resource-pill__rate"
            style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', marginTop: 2, color: primary.color }}
          >{primary.txt}</div>
        )}
      </div>
      {(hasRate || hasLocal) && (
        // Full breakdown — hover (desktop) / focus (mobile tap). Absolute,
        // so revealing it never reflows the bar.
        <div className="resource-pill__pop" role="note">
          <span style={{ color: '#7fffa1' }}>+{fmtRate(rate)}/t</span> {t('topbar.pill.pool')}
          {hasUpkeep && (
            <> &nbsp;·&nbsp; <span style={{ color: '#ff7a7a' }}>−{fmtRate(upkeep)}/t</span> {t('topbar.pill.fleet')}</>
          )}
          {hasLocal && (
            <> &nbsp;·&nbsp; <span style={{ color: '#ffb84d' }}>~{fmtRate(local)}/t</span> {t('topbar.pill.local')}</>
          )}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------
// Turn-Based Mode COMMIT TURN button + budget popover.
//
// The bare button shows the planned-order headline (e.g. "3 orders ·
// +2 ships"). Hover/tap opens a popover with the full breakdown:
// every planned transfer, build-in-flight, and research progress.
//
// Fuel is dead (DESIGN-identity-economy.md §1.1) — transfers are free,
// so there's no spend to forecast or overspend to warn about. The
// budget is now purely "what lands this turn".
// ----------------------------------------------------------------

const CommitTurnButton: React.FC<{ onCommit: () => void }> = ({ onCommit }) => {
  useI18n();
  const { gameState } = useGameContext();
  const { ticksPerTurn } = useTurnBasedSettings();
  const [popoverOpen, setPopoverOpen] = useState(false);

  const budget = useMemo(
    () => computeTurnBudget(gameState, 'player', ticksPerTurn),
    [gameState, ticksPerTurn],
  );

  const headline = (() => {
    const parts: string[] = [];
    const ordersN = budget.plannedItems.length;
    if (ordersN > 0) parts.push(tn('topbar.budget.orders', ordersN));
    const buildsLanding = budget.buildItems.filter(b => b.detail === 'LANDS THIS TURN').length;
    if (buildsLanding > 0) parts.push(tn('topbar.budget.shipsLanding', buildsLanding));
    return parts.length > 0 ? parts.join(' · ') : t('topbar.budget.noOrders');
  })();

  const color = '#ffb84d';

  return (
    <div
      style={{ position: 'relative', marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      onMouseEnter={() => setPopoverOpen(true)}
      onMouseLeave={() => setPopoverOpen(false)}
    >
      <button
        className="sim-btn sim-btn--commit-turn"
        onClick={onCommit}
        title={t('topbar.budget.advanceTitle')}
        style={{
          background: color,
          color: '#0a1018',
          fontWeight: 700,
          letterSpacing: '0.12em',
          padding: '6px 14px',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          lineHeight: 1.15,
        }}
      >
        <span style={{ fontSize: 11 }}>{t('topbar.commit.button')}</span>
        <span style={{ fontSize: 9, opacity: 0.75, letterSpacing: '0.04em' }}>{headline}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setPopoverOpen(p => !p); }}
        title={t('topbar.budget.show')}
        aria-label={t('topbar.budget.show')}
        style={{
          width: 22, height: 22, borderRadius: 3,
          border: `1px solid ${color}`, background: 'transparent', color,
          fontSize: 11, cursor: 'pointer', padding: 0,
        }}
      >ⓘ</button>

      {popoverOpen && (
        <div
          role="dialog"
          aria-label={t('topbar.budget.dialog')}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 280,
            maxWidth: 360,
            zIndex: 1120,
            background: 'linear-gradient(180deg, #131c27 0%, #070b13 100%)',
            border: `1px solid ${color}`,
            borderRadius: 6,
            padding: '10px 12px',
            fontFamily: 'var(--font-body)',
            color: '#d8e4ee',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.6)',
          }}
        >
          <div style={{ fontSize: 10, color, letterSpacing: '0.12em', marginBottom: 6 }}>
            {t('topbar.budget.next', { n: ticksPerTurn })}
          </div>

          <BudgetRow label={t('topbar.budget.planned')} count={budget.plannedItems.length} delta="" />
          {budget.plannedItems.slice(0, 4).map((it, i) => (
            <div key={i} style={{ fontSize: 10, color: '#b8c8d6', paddingLeft: 8 }}>
              · {it.label}{it.detail ? ` — ${it.detail}` : ''}
            </div>
          ))}
          {budget.plannedItems.length > 4 && (
            <div style={{ fontSize: 10, color: '#b8c8d6', paddingLeft: 8 }}>
              · {t('topbar.budget.more', { n: budget.plannedItems.length - 4 })}
            </div>
          )}

          <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />

          <BudgetRow
            label={t('topbar.budget.builds')}
            count={budget.buildItems.length}
            delta={
              budget.buildItems.filter(b => b.detail === 'LANDS THIS TURN').length > 0
                ? t('topbar.budget.landThisTurn', { n: budget.buildItems.filter(b => b.detail === 'LANDS THIS TURN').length })
                : ''
            }
          />
          {budget.buildItems.slice(0, 3).map((it, i) => (
            <div
              key={i}
              style={{
                fontSize: 10,
                color: it.detail === 'LANDS THIS TURN' ? '#7fffa1' : '#b8c8d6',
                paddingLeft: 8,
              }}
            >
              · {it.label} — {it.detail}
            </div>
          ))}

          {budget.research && budget.research.techId && (
            <>
              <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />
              <BudgetRow
                label={t('topbar.nav.research')}
                count={1}
                delta={`${budget.research.progressPct.toFixed(0)}% · ${budget.research.techId}`}
              />
            </>
          )}

          <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />

          <div style={{ fontSize: 10, color: '#b8c8d6' }}>
            {t('topbar.budget.pool', { ore: Math.round(budget.pool.ore), credits: Math.round(budget.pool.credits), science: Math.round(budget.pool.science) })}
          </div>
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------
// MP COMMIT TURN button — variant for server-driven turn batches.
//
// Differences from the SP button:
//  * Reads readiness from the /turn/status poll (mpTurnStatus prop)
//    rather than from a local TBM context.
//  * Once the caller has voted (me_committed=true), the button locks
//    and shows "WAITING ON N FACTION(S)". When the server advances,
//    the next poll resets me_committed and the button re-enables.
//  * No SP budget popover — MP budget would need cross-faction data
//    we don't have. Future: surface own-faction budget here too.
// ----------------------------------------------------------------

const MpCommitTurnButton: React.FC<{
  status: import('../multiplayer/MultiplayerActionsContext').TurnStatus;
  onCommit: () => Promise<void>;
}> = ({ status, onCommit }) => {
  useI18n();
  const [busy, setBusy] = useState(false);
  const locked = status.me_committed || busy;
  const waitingOn = status.needed - status.ready;

  const handleClick = async () => {
    if (locked) return;
    setBusy(true);
    try { await onCommit(); } finally { setBusy(false); }
  };

  const label = locked
    ? (waitingOn > 0 ? t('topbar.commit.waiting', { n: waitingOn }) : t('topbar.commit.advancing'))
    : t('topbar.commit.button');
  const color = locked ? '#5a7080' : '#ffb84d';

  return (
    <div style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={handleClick}
        disabled={locked}
        title={t('topbar.commit.title', { turn: status.turn_number, ready: status.ready, needed: status.needed, ticks: status.ticks_per_turn })}
        style={{
          background: color, color: '#0a1018',
          fontWeight: 700, letterSpacing: '0.12em',
          padding: '6px 14px', border: 'none', borderRadius: 4,
          cursor: locked ? 'default' : 'pointer',
          display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start',
          lineHeight: 1.15, opacity: locked ? 0.7 : 1,
        }}
      >
        <span style={{ fontSize: 11 }}>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.75, letterSpacing: '0.04em' }}>
          {t('topbar.commit.sub', { turn: status.turn_number, ready: status.ready, needed: status.needed })}
        </span>
      </button>
    </div>
  );
};

// MP-only host control for enabling Turn-Based Mode on the active
// game. Lives in the SideMenu HOST ADMIN section so non-hosts can't
// Host-only "publish the Discord digest now" button for the HOST ADMIN
// section. Fires POST /admin/digest-now which posts today's Orbital
// Herald edition to the configured Discord webhook immediately (a quiet
// day gets a short "all quiet" special edition). Result is surfaced
// inline in the hint slot: posted + event count, or the error.
// Host-only: open more seats in a game already running (worker/lobby.js
// handleRaiseSeats). Raise only, up to the cap of 10; a new seat fills
// like any running game's, from Browse's "Join in progress".
const SEAT_CAP = 10;
const HostSeatsControl: React.FC<{ gameId: string }> = ({ gameId }) => {
  useI18n();
  const [seats, setSeats] = useState<{ max: number; taken: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch<{ settings: { max_players: number; member_count?: number } }>(
        `/api/lobby/rooms/${gameId}/settings`,
      );
      if (live && res.ok) setSeats({ max: res.data.settings.max_players, taken: res.data.settings.member_count ?? 0 });
    })();
    return () => { live = false; };
  }, [gameId]);

  const raise = async (to: number) => {
    if (!seats || busy) return;
    const more = to - seats.max;
    if (!window.confirm(tn('topbar.seats.confirm', more, { to }))) return;
    setBusy(true);
    setStatus(null);
    try {
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch<{ settings: { max_players: number; member_count?: number } }>(
        `/api/lobby/rooms/${gameId}/seats`,
        { method: 'PATCH', body: JSON.stringify({ max_players: to }) },
      );
      if (res.ok) {
        setSeats({ max: res.data.settings.max_players, taken: res.data.settings.member_count ?? seats.taken });
        setStatus(t('topbar.seats.done', { n: res.data.settings.max_players }));
      } else {
        setStatus(res.error?.message ?? t('topbar.failed', { status: res.status }));
      }
    } catch (e) {
      setStatus(t('topbar.networkError', { msg: (e as Error)?.message || t('topbar.unknown') }));
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 4000);
    }
  };

  if (!seats) return null;
  const options: number[] = [];
  for (let n = seats.max + 1; n <= SEAT_CAP; n++) options.push(n);
  return (
    <div className="side-menu__item side-menu__item--block">
      <span className="side-menu__item-icon">👥</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <span className="side-menu__item-label" style={{ marginBottom: 2 }}>
          {status ?? (busy ? t('topbar.updating') : t('topbar.seats.taken', { taken: seats.taken, max: seats.max }))}
        </span>
        {options.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {options.map(n => (
              <button
                key={n}
                className="side-menu__pill"
                onClick={() => raise(n)}
                disabled={busy}
                title={tn('topbar.seats.openTitle', n - seats.max, { total: n })}
              >
                {n}
              </button>
            ))}
          </div>
        ) : null}
        <span className="side-menu__item-hint" style={{ marginTop: 2 }}>
          {options.length > 0
            ? t('topbar.seats.raiseHint')
            : t('topbar.seats.atMax', { n: SEAT_CAP })}
        </span>
      </div>
    </div>
  );
};

const PublishHeraldButton: React.FC<{ gameId: string }> = ({ gameId }) => {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Whether `result` reports a successful publish. Tracked as a flag, not
  // by sniffing the (translated) text.
  const [published, setPublished] = useState(false);

  const fire = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setPublished(false);
    try {
      // Lazy-import apiFetch — same pattern as the diagnostics export
      // below — so TopBar's module graph stays MP-agnostic.
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch<{ posted: boolean; events: number; reason?: string }>(
        `/api/games/${gameId}/admin/digest-now`,
        { method: 'POST' },
      );
      if (res.ok) {
        setPublished(!!res.data.posted);
        setResult(res.data.posted
          ? tn('topbar.herald.published', res.data.events)
          : t('topbar.herald.notPosted', { reason: res.data.reason ?? t('topbar.unknown') }));
      } else {
        setResult(res.error?.message ?? t('topbar.herald.failed'));
      }
    } catch {
      setResult(t('topbar.herald.requestFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="side-menu__item" onClick={fire} disabled={busy}
      title={t('topbar.herald.title')}>
      <span className="side-menu__item-icon">🗞</span>
      <span className="side-menu__item-label">{busy ? t('topbar.herald.publishing') : t('topbar.herald.publish')}</span>
      <span className="side-menu__item-hint" style={published ? { color: '#6ee7b7' } : undefined}>
        {result ?? t('topbar.herald.digest')}
      </span>
    </button>
  );
};

// see or change it. Reads current state from /turn/status and writes
// via POST /turn/settings. Editing ticks_per_turn uses the same
// pill-stepper pattern as the existing tick-interval admin.
const MpTbmHostToggle: React.FC = () => {
  useI18n();
  const mp = useMultiplayerActions();
  const { status, refresh } = useMpTurnStatus();
  const [busy, setBusy] = useState(false);
  // Surface server-side rejections (not_host, bad_request) inline so
  // a non-host clicking the toggle sees why nothing happened. Without
  // this the pill just flickered busy → idle with status unchanged.
  const [tbmError, setTbmError] = useState<string | null>(null);

  if (!mp || !status) return null;

  const setTBM = async (enabled: boolean, ticks: number) => {
    setBusy(true);
    setTbmError(null);
    try {
      const res = await mp.setTurnSettings(enabled, ticks);
      if (!res.ok) {
        setTbmError(humanizeMpError(res.code, res.error, 'tbm'));
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const ticksOptions = [10, 20, 50, 100];

  return (
    <div className="side-menu__item side-menu__item--block">
      <span className="side-menu__item-icon">⏯</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <span className="side-menu__item-label" style={{ marginBottom: 2 }}>
          {status.turn_based_enabled ? t('topbar.tbm.on') : t('topbar.tbm.off')}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="side-menu__pill"
            onClick={() => setTBM(!status.turn_based_enabled, status.ticks_per_turn)}
            disabled={busy}
          >
            {status.turn_based_enabled ? t('topbar.tbm.disable') : t('topbar.tbm.enable')}
          </button>
        </div>
        {status.turn_based_enabled && (
          <>
            <span className="side-menu__item-hint">{t('topbar.tbm.ticksPerTurn')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {ticksOptions.map(t => (
                <button
                  key={t}
                  className="side-menu__pill"
                  onClick={() => setTBM(true, t)}
                  disabled={busy}
                  style={t === status.ticks_per_turn ? { borderColor: '#ffb84d', color: '#ffb84d' } : undefined}
                >
                  +{t}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="side-menu__item-hint" style={{ marginTop: 2 }}>
          {status.turn_based_enabled
            ? t('topbar.tbm.paused', { ready: status.ready, needed: status.needed, turn: status.turn_number })
            : t('topbar.tbm.onSchedule')}
        </span>
        {tbmError && (
          // Server rejected the toggle (almost always not_host on a
          // joined-mid-game client). Click to dismiss.
          <button
            onClick={() => setTbmError(null)}
            style={{
              marginTop: 4, padding: '4px 8px',
              background: 'rgba(255, 94, 94, 0.1)',
              border: '1px solid #ff5e5e', borderRadius: 4,
              color: '#ff5e5e', fontSize: 10, lineHeight: 1.3,
              fontFamily: 'inherit', textAlign: 'left',
              cursor: 'pointer', width: '100%',
            }}
            title={t('topbar.clickDismiss')}
          >⚠ {tbmError}</button>
        )}
      </div>
    </div>
  );
};

const BudgetRow: React.FC<{ label: string; count: number; delta?: string; warn?: boolean }> = ({
  label, count, delta, warn,
}) => (
  <div
    style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      fontSize: 11, padding: '2px 0',
    }}
  >
    <span>
      <span style={{ color: '#d8e4ee' }}>{label}</span>
      <span style={{ color: '#b8c8d6', marginLeft: 6 }}>×{count}</span>
    </span>
    {delta && (
      <span style={{ color: warn ? '#ff5e5e' : '#ffb84d', fontWeight: 600 }}>{delta}</span>
    )}
  </div>
);

// ----------------------------------------------------------------
// Side drawer: slides in from the left when the logo is clicked.
// Houses navigation actions (Back to Menu, Sign Out) and identity
// so the in-game top bar stays focused on resources + sim controls.
// ----------------------------------------------------------------


/** Re-renders on toggle so the menu row reflects the live setting.
 *  lightweightMode itself stays React-free — the render path imports it. */
function useLightweight(): boolean {
  const [on, setOn] = useState(isLightweight);
  useEffect(() => subscribeLightweight(setOn), []);
  return on;
}


/**
 * Lightweight mode row. A client render setting, so it sits in GAME
 * alongside the tutorial rather than under HOST ADMIN — it changes only
 * what this browser draws and never touches the match.
 */
const LightweightToggle: React.FC = () => {
  useI18n();
  const on = useLightweight();
  return (
    <button
      className="side-menu__item"
      onClick={() => setLightweight(!on)}
      title={on
        ? t('topbar.light.onTitle')
        : t('topbar.light.offTitle')}
    >
      <span className="side-menu__item-icon">{on ? '▱' : '◈'}</span>
      <span className="side-menu__item-label">
        {on ? t('topbar.light.on') : t('topbar.light.off')}
      </span>
      <span
        className="side-menu__item-hint"
        style={{ color: on ? '#ffb84d' : undefined }}
      >
        {on ? t('topbar.light.hintOn') : t('topbar.light.hintOff')}
      </span>
    </button>
  );
};

interface SideMenuProps {
  onClose: () => void;
  onExitMode?: () => void;
  user: { display_name: string; email: string; shadow?: boolean } | null;
  onSignOut: () => Promise<void> | void;
  /** Opens the account-level notification preferences dialog. */
  onOpenNotifications?: () => void;
  /** When set + isHost, the menu shows admin controls (force tick, etc.). */
  adminGameId?: string | null;
  isHost?: boolean;
  /** Panel state + toggle — drives the mobile-only Panels group below. */
  activePanel?: PanelId;
  onTogglePanel?: (panel: PanelId) => void;
  playerShipCount?: number;
  settlementCount?: number;
  researchTotal?: number;
  /** SP-only: show Save / Load entries in the GAME section. */
  canSaveLoad?: boolean;
  onOpenSave?: () => void;
  onOpenLoad?: () => void;
  /** Open the admin resource-grant modal. SP-always; MP-host-only
   *  (server enforces). Wired from TopBar. */
  onOpenAdminGrant?: () => void;
  onOpenAnalytics?: () => void;
}

// ----------------------------------------------------------------
// TICK SPEED: one control, two modes (design approved by Lorne
// 2026-10-19, claude.ai/artifact/5RoKcC2ouQPJZhTVQraoke).
//
//   All day      the speed buttons, applied on the click, as before.
//   Day & night  a 24-hour strip showing every tick, plus two rows
//                (start time, speed) with arrow steppers. Saved as a
//                two-period schedule (worker/tickSchedule.js).
//
// Players asked for it over and over (Moitão 2026-10-05 / 10-09): fast
// ticks while everyone is awake, slow ones overnight, so staying up buys
// less. Everyone sees the schedule (TickScheduleLine); only the host
// edits it.
// ----------------------------------------------------------------

const SunIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#e8a33d" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MoonIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#8f9cf0" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </svg>
);

const hourLabel = (h: number): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2026, 0, 1, h % 24));
  } catch { return `${h % 24}`; }
};

/** The 24-hour strip: day and night bands, a mark per tick, a now line. */
const DayStrip: React.FC<{ dn: DayNight; nowMin: number; marks?: boolean; slim?: boolean }> = ({ dn, nowMin, marks = true, slim = false }) => {
  const cuts = Array.from(new Set([0, dn.dayAt, dn.nightAt, 1440])).sort((a, b) => a - b);
  const segs = cuts.slice(0, -1).map((a, i) => ({ a, b: cuts[i + 1] })).filter(s => s.b > s.a);
  const ticks = marks ? ticksOfDay(dn) : [];
  const label = t('topbar.tickSpeed.band', {
    day: clockLabel(dn.dayAt), daySpeed: speedLabel(dn.dayMs),
    night: clockLabel(dn.nightAt), nightSpeed: speedLabel(dn.nightMs),
  });
  return (
    <div className="tsx-strip-wrap">
      <div className={`tsx-strip${slim ? ' tsx-strip--slim' : ''}`} role="img" aria-label={label}>
        {segs.map(s => (
          <div
            key={s.a}
            className={inDay(dn, s.a) ? 'tsx-strip__day' : 'tsx-strip__night'}
            style={{ left: `${s.a / 14.4}%`, width: `${(s.b - s.a) / 14.4}%` }}
          />
        ))}
        {ticks.length <= 160 && ticks.map(k => (
          <div key={k.min} className={`tsx-strip__tick${k.day ? ' tsx-strip__tick--day' : ''}`} style={{ left: `${k.min / 14.4}%` }} />
        ))}
        <div className="tsx-strip__now" style={{ left: `${nowMin / 14.4}%` }} />
      </div>
      {!slim && (
        <div className="tsx-hours" aria-hidden="true">
          <span style={{ left: 0 }}>{hourLabel(0)}</span>
          <span style={{ left: '25%' }} className="tsx-hours--mid">{hourLabel(6)}</span>
          <span style={{ left: '50%' }} className="tsx-hours--mid">{hourLabel(12)}</span>
          <span style={{ left: '75%' }} className="tsx-hours--mid">{hourLabel(18)}</span>
          <span style={{ right: 0 }}>{hourLabel(24)}</span>
          <span style={{ left: `${nowMin / 14.4}%` }} className="tsx-hours--mid tsx-hours__now">{t('topbar.tickSpeed.now')}</span>
        </div>
      )}
    </div>
  );
};

const speedIndex = (ms: number): number => {
  const i = TICK_SPEED_OPTIONS.findIndex(o => o.value === ms);
  return i >= 0 ? i : 4;
};

const HostTickSpeed: React.FC<{ gameId: string }> = ({ gameId }) => {
  useI18n();
  const { gameState } = useGameContext();
  const live = gameState.tickSchedule ?? null;
  const liveDN = dayNightOf(live);
  const flatMs = gameState.tickIntervalMs ?? 3_600_000;
  const [mode, setMode] = useState<'flat' | 'day'>(live ? 'day' : 'flat');
  const [draft, setDraft] = useState<DayNight | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // A schedule arriving (or going) from the server shows its own mode.
  const hasLive = !!live;
  useEffect(() => { setMode(hasLive ? 'day' : 'flat'); setDraft(null); }, [hasLive]);

  const dn = draft ?? liveDN ?? DEFAULT_DAY_NIGHT();
  const canSave = draft != null || !live || !liveDN;
  const nowMin = localMinutes(dn.tz, Date.now());
  const ticks = ticksOfDay(dn);
  const nightCount = ticks.filter(k => !k.day).length;
  const edit = (patch: Partial<DayNight>) => setDraft({ ...dn, ...patch });
  const say = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), 4000);
  };

  const call = async (path: string, body: unknown, done: string) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch(`/api/lobby/rooms/${gameId}/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (res.ok) { setDraft(null); say(done); }
      else say(res.error?.message ?? t('topbar.failed', { status: res.status }));
    } catch (e) {
      say(t('topbar.networkError', { msg: (e as Error)?.message || t('topbar.unknown') }));
    } finally {
      setBusy(false);
    }
  };

  const shiftTime = (key: 'dayAt' | 'nightAt', by: number) => {
    const other = key === 'dayAt' ? dn.nightAt : dn.dayAt;
    let v = (dn[key] + by + 1440) % 1440;
    if (v === other) v = (v + by + 1440) % 1440;
    edit({ [key]: v } as Partial<DayNight>);
  };
  const shiftSpeed = (key: 'dayMs' | 'nightMs', by: number) => {
    const i = Math.max(0, Math.min(TICK_SPEED_OPTIONS.length - 1, speedIndex(dn[key]) + by));
    edit({ [key]: TICK_SPEED_OPTIONS[i].value } as Partial<DayNight>);
  };
  const zones = Array.from(new Set([dn.tz, localTimeZone(), ...COMMON_ZONES]));
  const nowSpeed = mode === 'day' && live ? speedLabel(inDay(dn, nowMin) ? dn.dayMs : dn.nightMs) : speedLabel(flatMs);

  const row = (isDay: boolean) => {
    const name = isDay ? t('topbar.tickSpeed.day') : t('topbar.tickSpeed.night');
    const at = isDay ? 'dayAt' : 'nightAt';
    const sp = isDay ? 'dayMs' : 'nightMs';
    return (
      <div className={`tsx-row ${isDay ? 'tsx-row--day' : 'tsx-row--night'}`} key={at}>
        <div className="tsx-row__name">
          {isDay ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          <span>{name}</span>
        </div>
        <div className="tsx-step">
          <button type="button" aria-label={t('topbar.tickSpeed.earlier', { name })} onClick={() => shiftTime(at, -30)}>‹</button>
          <span>{clockLabel(dn[at])}</span>
          <button type="button" aria-label={t('topbar.tickSpeed.later', { name })} onClick={() => shiftTime(at, 30)}>›</button>
        </div>
        <div className="tsx-step tsx-step--speed">
          <button type="button" aria-label={t('topbar.tickSpeed.faster', { name })} onClick={() => shiftSpeed(sp, -1)}>‹</button>
          <span>{speedLabel(dn[sp])}</span>
          <button type="button" aria-label={t('topbar.tickSpeed.slower', { name })} onClick={() => shiftSpeed(sp, 1)}>›</button>
        </div>
      </div>
    );
  };

  return (
    <section className="side-menu__item side-menu__item--block tsx" aria-labelledby="tsx-title">
      <span className="side-menu__item-icon">⏱</span>
      <div className="tsx__body">
        <div className="tsx__head">
          <span id="tsx-title" className="side-menu__item-label">
            {status ?? (busy ? t('topbar.updating') : t('topbar.admin.tickSpeed'))}
          </span>
          <span className="tsx__now">{t('topbar.tickSpeed.nowSpeed', { speed: nowSpeed })}</span>
        </div>

        <div className="tsx-mode" role="group" aria-label={t('topbar.admin.tickSpeed')}>
          <button type="button" aria-pressed={mode === 'flat'} onClick={() => setMode('flat')}>{t('topbar.tickSpeed.allDay')}</button>
          <button type="button" aria-pressed={mode === 'day'} onClick={() => setMode('day')}>{t('topbar.tickSpeed.dayNight')}</button>
        </div>

        {mode === 'flat' ? (
          <>
            <div className="tsx-pills">
              {TICK_SPEED_OPTIONS.map(o => (
                <button
                  key={o.value}
                  type="button"
                  className="side-menu__pill"
                  aria-pressed={!live && o.value === flatMs}
                  disabled={busy}
                  title={t('topbar.admin.perTick', { label: o.label })}
                  onClick={() => call('tick-interval', { tick_interval_ms: o.value },
                    t('topbar.tickSpeed.ticking', { speed: o.label }))}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="side-menu__item-hint tsx__wrap">
              {live
                ? t('topbar.tickSpeed.flatOverrides')
                : t('topbar.tickSpeed.flatCount', { n: Math.round(86_400_000 / flatMs).toLocaleString() })}
            </span>
          </>
        ) : (
          <>
            <DayStrip dn={dn} nowMin={nowMin} />
            <div className="tsx-rows">
              {row(true)}
              {row(false)}
              <div className="tsx-cols" aria-hidden="true">
                <span />
                <span>{t('topbar.tickSpeed.from')}</span>
                <span>{t('topbar.tickSpeed.every')}</span>
              </div>
            </div>
            <div className="tsx-total">
              <span className="tsx-total__n">{ticks.length.toLocaleString()}</span>
              <span>{t('topbar.tickSpeed.total', { night: nightCount.toLocaleString() })}</span>
            </div>
            <label className="tsx-clock">
              {t('topbar.tickSpeed.clock')}
              <select value={dn.tz} onChange={e => { const tz = e.target.value; edit({ tz }); }}>
                {zones.map(z => (
                  <option key={z} value={z}>{t('topbar.tickSpeed.zoneTime', { zone: zoneLabel(z) })}</option>
                ))}
              </select>
            </label>
            {live && !liveDN && (
              <span className="side-menu__item-hint tsx__wrap">
                {t('topbar.tickSpeed.custom', { n: live.periods.length })}
              </span>
            )}
            <div className="tsx-actions">
              <button
                type="button"
                className="tsx-btn tsx-btn--go"
                disabled={busy || !canSave}
                onClick={() => call('tick-schedule', { schedule: scheduleOf(dn) }, t('topbar.tickSpeed.saved'))}
              >
                {t('topbar.sched.save')}
              </button>
              <button
                type="button"
                className="tsx-btn"
                disabled={busy}
                onClick={() => { setDraft(null); if (!live) setMode('flat'); }}
              >
                {t('topbar.sched.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
};

/** What every player sees in the side menu while a schedule runs. */
const TickScheduleLine: React.FC = () => {
  useI18n();
  const { gameState } = useGameContext();
  const s = gameState.tickSchedule;
  if (!s) return null;
  const dn = dayNightOf(s);
  if (!dn) {
    return (
      <div className="side-menu__item side-menu__item--block" title={s.tz}>
        <span className="side-menu__item-icon">⏱</span>
        <div className="tsx__body">
          <span className="side-menu__item-label">{t('topbar.admin.tickSpeed')}</span>
          <span className="side-menu__item-hint tsx__wrap">{describeSchedule(s)} ({t('topbar.tickSpeed.zoneTime', { zone: zoneLabel(s.tz) })})</span>
        </div>
      </div>
    );
  }
  const nowMin = localMinutes(dn.tz, Date.now());
  const day = inDay(dn, nowMin);
  return (
    <div className="side-menu__item side-menu__item--block tsx">
      <span className="side-menu__item-icon">⏱</span>
      <div className="tsx__body">
        <div className="tsx__head">
          <span className="side-menu__item-label">{t('topbar.admin.tickSpeed')}</span>
          <span className="tsx__now">{t('topbar.tickSpeed.setBy')}</span>
        </div>
        <DayStrip dn={dn} nowMin={nowMin} marks={false} slim />
        <div className="tsx-cells">
          <div>
            <span className="tsx-cells__day">{t('topbar.tickSpeed.day')}</span>
            <span>{t('topbar.tickSpeed.cellLine', { speed: speedLabel(dn.dayMs), at: clockLabel(dn.dayAt) })}</span>
          </div>
          <div>
            <span className="tsx-cells__night">{t('topbar.tickSpeed.night')}</span>
            <span>{t('topbar.tickSpeed.cellLine', { speed: speedLabel(dn.nightMs), at: clockLabel(dn.nightAt) })}</span>
          </div>
        </div>
        <span className="side-menu__item-hint tsx__wrap">
          {t(day ? 'topbar.tickSpeed.nightIn' : 'topbar.tickSpeed.dayIn', {
            zone: t('topbar.tickSpeed.zoneTime', { zone: zoneLabel(dn.tz) }),
            in: untilLabel(nowMin, day ? dn.nightAt : dn.dayAt),
          })}
        </span>
      </div>
    </div>
  );
};

/** The top bar's "day · 30m" chip beside the countdown, while a
 *  schedule runs. Its title spells the whole schedule out. */
const TickSpeedChip: React.FC = () => {
  const { gameState } = useGameContext();
  const s = gameState.tickSchedule;
  if (!s) return null;
  const dn = dayNightOf(s);
  const ms = gameState.tickIntervalMs ?? 0;
  const day = dn ? inDay(dn, localMinutes(dn.tz, Date.now())) : null;
  return (
    <span
      className={`tsx-chip${day === false ? ' tsx-chip--night' : ''}`}
      title={`${describeSchedule(s)} (${t('topbar.tickSpeed.zoneTime', { zone: zoneLabel(s.tz) })})`}
    >
      {day === false ? <MoonIcon size={10} /> : <SunIcon size={10} />}
      {day == null ? speedLabel(ms) : `${t(day ? 'topbar.tickSpeed.chipDay' : 'topbar.tickSpeed.chipNight')} · ${speedLabel(ms)}`}
    </span>
  );
};

const SideMenu: React.FC<SideMenuProps> = ({
  onClose, onExitMode, user, onSignOut, onOpenNotifications,
  adminGameId = null, isHost = false,
  activePanel, onTogglePanel,
  playerShipCount = 0, settlementCount = 0, researchTotal = 0,
  canSaveLoad = false, onOpenSave, onOpenLoad, onOpenAdminGrant, onOpenAnalytics,
}) => {
  useI18n();
  const [forceTickBusy, setForceTickBusy] = useState(false);
  const [forceTickStatus, setForceTickStatus] = useState<string | null>(null);
  // Turn-Based Mode toggle (live setting, persisted to localStorage).
  // Hidden in multiplayer — the server is authoritative there and TBM
  // would need server-side turn collection to work, which isn't built.
  const tbm = useTurnBasedSettings();
  const tbmAvailable = !adminGameId; // adminGameId is MP-only; SP leaves it null
  // Tutorial — replay entry under GAME. The first-game prompt has its
  // own modal; this menu item is the "I want to see it again" path.
  const tutorial = useTutorial();
  // A trial game replays ITS tour (the one it opened with), and says how
  // long that one is: the menu offered "24 steps" beside a 12-step tour.
  const { gameState: menuGame } = useGameContext();
  const trialGame = !!menuGame.solo?.trial;
  // A phone has no Esc key: no "Press Esc to close" footer there.
  const isMobile = useIsMobile();
  // "Log copied" / failure note on the Download Log row. The menu sits
  // over the toast layer, so the row itself has to say what happened.
  const [logStatus, setLogStatus] = useState<string | null>(null);

  async function forceTick() {
    if (!adminGameId || forceTickBusy) return;
    setForceTickBusy(true);
    setForceTickStatus(null);
    try {
      // Lazy-import apiFetch to avoid polluting TopBar's module graph
      // for single-player builds that don't need multiplayer code paths.
      const { apiFetch } = await import('../multiplayer/api');
      const res = await apiFetch<{ current_tick?: number; advanced?: boolean; bodies_added?: number }>(
        `/api/lobby/rooms/${adminGameId}/force-tick`,
        { method: 'POST' },
      );
      if (!res.ok) {
        setForceTickStatus(res.error?.message ?? t('topbar.failed', { status: res.status }));
      } else {
        const bodiesNote = res.data?.bodies_added && res.data.bodies_added > 0
          ? ` ${t('topbar.admin.bodiesAdded', { n: res.data.bodies_added })}`
          : '';
        if (res.data?.advanced === false) {
          // Worker returned 200 but the tick didn't actually move — usually
          // means the DO bailed (no game / status mismatch). Surface that.
          setForceTickStatus(`${t('topbar.admin.noChange')}${bodiesNote}`);
        } else {
          setForceTickStatus(`${t('topbar.admin.tickTo', { tick: res.data?.current_tick ?? '?' })}${bodiesNote}`);
        }
      }
    } catch (e) {
      setForceTickStatus(t('topbar.networkError', { msg: (e as Error)?.message || t('topbar.unknown') }));
    } finally {
      setForceTickBusy(false);
      setTimeout(() => setForceTickStatus(null), 4000);
    }
  }

  // Portal to <body> for the same reason as EventLogPanel: .top-bar's
  // backdrop-filter would otherwise trap our fixed-positioned drawer.
  return createPortal(
    <>
      <div className="side-menu__backdrop" onClick={onClose} />
      <aside className="side-menu" role="dialog" aria-label={t('topbar.menu')}>
        <header className="side-menu__head">
          <div>
            <div className="side-menu__brand">ORBITAL</div>
            <div className="side-menu__brand-sub" title={t('topbar.build', { sha: GIT_SHA })}>v0.3 alpha · {GIT_SHA.slice(0,7)}</div>
          </div>
          <button className="side-menu__close" onClick={onClose} title={t('topbar.closeEsc')}>×</button>
        </header>

        <section className="side-menu__identity">
          <div className="side-menu__identity-label">{t('topbar.signedInAs')}</div>
          <div className="side-menu__identity-name">
            {user ? (user.display_name || user.email) : t('topbar.guest')}
          </div>
          {user && <div className="side-menu__identity-sub">{user.shadow ? t('trial.menu.unsaved') : user.email}</div>}
        </section>

        <nav className="side-menu__nav">
          {onTogglePanel && (
            <div className="side-menu__panels-mobile">
              <div className="side-menu__group-label">{t('topbar.menuPanels')}</div>
              <button
                className={`side-menu__item${activePanel === 'settlements' ? ' side-menu__item--active' : ''}`}
                onClick={() => { onClose(); onTogglePanel(activePanel === 'settlements' ? null : 'settlements'); }}
              >
                <span className="side-menu__item-icon">⌂</span>
                <span className="side-menu__item-label">{t('topbar.menuSettlements')}</span>
                <span className="side-menu__item-hint">{settlementCount}</span>
              </button>
              <button
                className={`side-menu__item${activePanel === 'fleet' ? ' side-menu__item--active' : ''}`}
                onClick={() => { onClose(); onTogglePanel(activePanel === 'fleet' ? null : 'fleet'); }}
              >
                <span className="side-menu__item-icon">◈</span>
                <span className="side-menu__item-label">{t('topbar.nav.fleet')}</span>
                <span className="side-menu__item-hint">{playerShipCount}</span>
              </button>
              <button
                className={`side-menu__item${activePanel === 'research' ? ' side-menu__item--active' : ''}`}
                onClick={() => { onClose(); onTogglePanel(activePanel === 'research' ? null : 'research'); }}
              >
                <span className="side-menu__item-icon">⚛</span>
                <span className="side-menu__item-label">{t('topbar.nav.research')}</span>
                <span className="side-menu__item-hint">{researchTotal || t('topbar.lvl0')}</span>
              </button>
            </div>
          )}

          <div className="side-menu__group-label">{t('topbar.menuGame')}</div>
          {/* The language, mid-game (it was only in the lobby). Switches
              live: every panel re-renders, and the game provider re-maps
              /state so world names and the log follow. Saved on the
              account when there is one, as the lobby picker does. */}
          <div className="side-menu__item side-menu__lang" data-testid="menu-language">
            <span className="side-menu__item-icon" aria-hidden>🌐</span>
            <span className="side-menu__item-label">{t('lang.label')}</span>
            <LanguageSwitch className="side-menu__lang-switch" onChosen={user ? saveLocale : undefined} />
          </div>
          {canSaveLoad && onOpenSave && (
            <button
              className="side-menu__item"
              onClick={onOpenSave}
              title={t('topbar.save.title')}
            >
              <span className="side-menu__item-icon">⤓</span>
              <span className="side-menu__item-label">{t('topbar.save.label')}</span>
              <span className="side-menu__item-hint">localStorage</span>
            </button>
          )}
          {canSaveLoad && onOpenLoad && (
            <button
              className="side-menu__item"
              onClick={onOpenLoad}
              title={t('topbar.load.title')}
            >
              <span className="side-menu__item-icon">⤒</span>
              <span className="side-menu__item-label">{t('topbar.load.label')}</span>
              <span className="side-menu__item-hint">{t('topbar.load.hint')}</span>
            </button>
          )}
          {/* A solo game's clock on a narrow phone: the bar keeps pause /
              resume; speed and the single tick are here (SoloClock.css). */}
          {menuGame.solo && isMobile && (
            <button
              className="side-menu__item"
              onClick={() => window.dispatchEvent(new CustomEvent('orbital:solo-clock', { detail: { action: 'speed' } }))}
              title={t('solo.speedTitle')}
            >
              <span className="side-menu__item-icon">⏱</span>
              <span className="side-menu__item-label">{t('solo.menu.speed', { speed: soloSpeedLabel(menuGame.tickIntervalMs ?? 120_000) })}</span>
              <span className="side-menu__item-hint">{t('solo.menu.speedHint', { next: soloSpeedLabel(nextSoloSpeed(menuGame.tickIntervalMs ?? 120_000)) })}</span>
            </button>
          )}
          {menuGame.solo?.paused && isMobile && (
            <button
              className="side-menu__item"
              onClick={() => window.dispatchEvent(new CustomEvent('orbital:solo-clock', { detail: { action: 'step' } }))}
              title={t('solo.stepTitle')}
            >
              <span className="side-menu__item-icon">⏭</span>
              <span className="side-menu__item-label">{t('solo.step')}</span>
              <span className="side-menu__item-hint">{t('solo.stepTitle')}</span>
            </button>
          )}
          {/* A Play for Free trial (trial.js): keep it. First in the menu. */}
          {user?.shadow && (
            <button
              className="side-menu__item side-menu__item--save"
              onClick={() => { onClose(); openSaveEmpire('menu'); }}
            >
              <span className="side-menu__item-icon">★</span>
              <span className="side-menu__item-label">{t('trial.menu.save')}</span>
            </button>
          )}
          {onExitMode && (
            <button
              className="side-menu__item"
              onClick={() => { onClose(); onExitMode(); }}
            >
              <span className="side-menu__item-icon">←</span>
              <span className="side-menu__item-label">{t('topbar.backToMenu')}</span>
              <span className="side-menu__item-hint">{t('topbar.exitSession')}</span>
            </button>
          )}
          <button
            className="side-menu__item"
            onClick={() => {
              // reset() clears the completed flag so the next time a
              // player enters a game the prompt fires again. Calling
              // start() directly also relaunches the tour now without
              // requiring a reload.
              // (The trial's tour has its own done flag; reset() is the
              // full tour's, so a trial leaves it alone.)
              if (trialGame) tutorial.startTrial();
              else { tutorial.reset(); tutorial.start(); }
              onClose();
            }}
            title={t('topbar.tutorial.title')}
          >
            <span className="side-menu__item-icon">?</span>
            <span className="side-menu__item-label">
              {tutorial.completed ? t('topbar.tutorial.replay') : t('topbar.tutorial.start')}
            </span>
            <span className="side-menu__item-hint">{t('topbar.tutorial.hint', { n: trialGame ? TRIAL_TUTORIAL_STEP_COUNT : TUTORIAL_STEP_COUNT })}</span>
          </button>

          <LightweightToggle />

          {tbmAvailable && (
            // SP Turn-Based Mode toggle. Persisted across sessions in
            // localStorage. Hidden in MP — the MP variant lives in HOST
            // ADMIN below (host-only since it changes the whole table's
            // tick rhythm).
            <button
              className="side-menu__item"
              onClick={() => tbm.setEnabled(!tbm.enabled)}
              title={tbm.enabled
                ? t('topbar.sptbm.onTitle', { n: tbm.ticksPerTurn })
                : t('topbar.sptbm.offTitle')}
            >
              <span className="side-menu__item-icon">{tbm.enabled ? '⏯' : '▶'}</span>
              <span className="side-menu__item-label">
                {tbm.enabled ? t('topbar.tbm.on') : t('topbar.tbm.off')}
              </span>
              <span
                className="side-menu__item-hint"
                style={{ color: tbm.enabled ? '#ffb84d' : undefined }}
              >
                {tbm.enabled ? t('topbar.sptbm.hintOn', { n: tbm.ticksPerTurn }) : t('topbar.sptbm.hintOff')}
              </span>
            </button>
          )}

          {!tbmAvailable && isHost && adminGameId && (
            // MP Turn-Based Mode (host-only). Posts /turn/settings, which
            // also short-circuits the Room DO alarm so wall-clock time
            // stops ticking and players have to opt in via COMMIT TURN.
            <MpTbmHostToggle />
          )}

          {/* Everyone sees the time-of-day schedule; the host edits it below. */}
          {!isHost && adminGameId && <TickScheduleLine />}

          {isHost && adminGameId && (
            <>
              <div className="side-menu__group-label">{t('topbar.admin.group')}</div>
              <button
                className="side-menu__item"
                onClick={forceTick}
                disabled={forceTickBusy}
              >
                <span className="side-menu__item-icon">⏭</span>
                <span className="side-menu__item-label">
                  {forceTickStatus ?? (forceTickBusy ? t('topbar.admin.ticking') : t('topbar.admin.forceTick'))}
                </span>
                <span className="side-menu__item-hint">{t('topbar.admin.forceTickHint')}</span>
              </button>
              <HostTickSpeed gameId={adminGameId!} />
              <HostSeatsControl gameId={adminGameId!} />
              <button
                className="side-menu__item"
                onClick={() => { onClose(); onOpenAdminGrant?.(); }}
              >
                <span className="side-menu__item-icon">$</span>
                <span className="side-menu__item-label">{t('topbar.admin.grant')}</span>
                <span className="side-menu__item-hint">{t('topbar.admin.grantHint')}</span>
              </button>
              <button
                className="side-menu__item"
                onClick={() => { onClose(); onOpenAnalytics?.(); }}
                title={t('topbar.admin.analyticsTitle')}
              >
                <span className="side-menu__item-icon">📈</span>
                <span className="side-menu__item-label">{t('topbar.analytics.title')}</span>
                <span className="side-menu__item-hint">{t('topbar.admin.analyticsHint')}</span>
              </button>
              <PublishHeraldButton gameId={adminGameId!} />
            </>
          )}

          {/* SP: surface the same admin tools under DEBUG (no MP host gate). */}
          {!adminGameId && onOpenAdminGrant && (
            <>
              <div className="side-menu__group-label">DEBUG</div>
              <button
                className="side-menu__item"
                onClick={() => { onClose(); onOpenAdminGrant?.(); }}
              >
                <span className="side-menu__item-icon">$</span>
                <span className="side-menu__item-label">Grant Resources</span>
                <span className="side-menu__item-hint">Bump any faction's pools</span>
              </button>
            </>
          )}

          <div className="side-menu__group-label">{t('topbar.diag.group')}</div>
          <button
            className="side-menu__item"
            onClick={() => {
              // Don't close the drawer — the user might want to inspect more
              // afterwards, and a download doesn't navigate.
              logger.info('SYSTEM', 'User exported game log');
              // Desktop: the same download as ever. Phone layout: share
              // sheet, else download (browser) or clipboard (the app,
              // where an <a download> silently does nothing). No await
              // before this call: the share sheet needs the tap.
              const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              void saveTextFile(logger.exportText(), `orbital-log-${stamp}.txt`, {
                mobile: isMobile,
                inApp: isInApp(),
                download: () => logger.downloadText(),
              }).then((outcome) => {
                const said = outcome === 'copied' ? t('topbar.diag.copiedToast')
                  : outcome === 'failed' ? t('topbar.diag.failedToast')
                  : null;
                if (!said) return;
                setLogStatus(outcome === 'copied' ? t('topbar.diag.copied') : t('topbar.diag.failed'));
                window.setTimeout(() => setLogStatus(null), 4000);
                try {
                  window.dispatchEvent(new CustomEvent('orbital:toast', {
                    detail: { text: said, kind: outcome === 'failed' ? 'error' : 'info' },
                  }));
                } catch { /* noop */ }
              });
            }}
          >
            <span className="side-menu__item-icon">⤓</span>
            <span className="side-menu__item-label">{t('topbar.diag.download')}</span>
            <span className="side-menu__item-hint">{logStatus ?? t('topbar.diag.entries', { n: logger.count() })}</span>
          </button>

          {user && (
            <>
              <div className="side-menu__group-label">{t('topbar.account.group')}</div>
              <button
                className="side-menu__item"
                onClick={() => { onClose(); onOpenNotifications?.(); }}
              >
                <span className="side-menu__item-icon">🔔</span>
                <span className="side-menu__item-label">{t('topbar.account.notifications')}</span>
                <span className="side-menu__item-hint">{t('topbar.account.notificationsHint')}</span>
              </button>
              {/* A SMALL WINDOW TO LEAVE OPEN. Not the game in miniature:
                  a page of its own that reads the same feeds the watch
                  does and repaints once a minute, so it can sit in the
                  corner of a monitor all day without a second map
                  canvas and a second socket running beside the one you
                  are playing in. */}
              <button
                className="side-menu__item"
                onClick={() => {
                  onClose();
                  window.open(
                    '/panel',
                    'orbital-panel',
                    'width=400,height=760,menubar=no,toolbar=no,location=no,status=no',
                  );
                }}
              >
                <span className="side-menu__item-icon">🛰</span>
                <span className="side-menu__item-label">{t('topbar.account.popout')}</span>
                <span className="side-menu__item-hint">{t('topbar.account.popoutHint')}</span>
              </button>
              {/* An unsaved trial: signing out would throw the empire away
                  (there is no way back in). Save is the way out. */}
              {!user.shadow && (
              <button
                className="side-menu__item side-menu__item--danger"
                onClick={async () => { onClose(); await onSignOut(); }}
              >
                <span className="side-menu__item-icon">⏏</span>
                <span className="side-menu__item-label">{t('topbar.account.signOut')}</span>
                <span className="side-menu__item-hint">{t('topbar.account.signOutHint')}</span>
              </button>
              )}
            </>
          )}
        </nav>

        {!isMobile && (
          <footer className="side-menu__foot">
            <span>{t('topbar.pressEsc.pre')} <kbd>Esc</kbd> {t('topbar.pressEsc.post')}</span>
          </footer>
        )}
      </aside>
    </>,
    document.body,
  );
};
