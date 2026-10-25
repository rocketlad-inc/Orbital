// ============================================================
// RoomEmpireEditor — the controls that make a player's empire, inside the
// "Your empire" card when it is opened (RoomYourEmpire).
//
// Everything the old lobby panel had, in the same order: name and note, flag
// (colour, trim, emblem, colony/station style), starting world, captains,
// custom names. The logic is unchanged; what moved is the presentation: real
// 44px buttons, classes in RoomLobby.css instead of inline styles.
// ============================================================

import React, { useId } from 'react';
import { CaptainRosterPicker } from './CaptainRosterPicker';
import { useAuth } from './AuthContext';
import { NamePoolEditor } from './NamePoolEditor';
import type { PastNameBank } from './NamePoolEditor';
import { SkinPicker } from './SkinPicker';
import { startCommissionCheckout } from './api';
import type { RoomSnapshot } from './api';
import {
  COMMISSION_LINES, COMMISSION_PRICE, logCommission, openCommissionInBrowser,
  COMMISSION_DISCORD, COMMISSION_NO_GAMEPLAY,
} from './commission';
import { isAndroidApp } from '../platform/appShell';
import { deriveSecondary, emblemInk } from '../game/colorUtils';
import { EMBLEM_IDS, PREMIUM_EMBLEM_IDS, EARNED_EMBLEM_IDS, EMBLEM_NAMES } from '../game/emblems';
import { FactionEmblem } from '../components/FactionEmblem';
import { RESOURCE_LETTER_COLORS, resourceLetter } from '../game/resourceColors';
import type { NamePools } from '../game/namePools';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';

/** Logs that the flag picker's Commission line was shown (once per page
 *  load, see commission.ts). A component so the effect runs only while
 *  the line is actually on screen. */
function CommissionFlagView() {
  React.useEffect(() => { logCommission('lobby-flag', 'view'); }, []);
  return null;
}

// Two-tone factions (§5): curated swatch grid — a modest 16 colors, not
// a full wheel. PRIMARY carries all meaning on the map; the server
// rejects only an EXACT duplicate of another member's primary (the old
// 90-unit perceptual-distance rule was dropped — it emptied the grid).
// SECONDARY is decoration only and free-pick from the same grid.
const FACTION_COLOR_CHOICES: string[] = [
  '#ff7043', // ember
  '#42a5f5', // azure
  '#66bb6a', // verdant
  '#ab47bc', // violet
  '#ffca28', // amber
  '#26c6da', // cyan
  '#ec407a', // rose
  '#8d6e63', // ferrous
  '#ef5350', // signal red
  '#5c6bc0', // indigo
  '#9ccc65', // lime
  '#ff8a65', // coral
  '#78909c', // steel
  '#d4e157', // chartreuse
  '#7e57c2', // amethyst
  '#f5f5f5', // white
];

export type FlagField = 'color' | 'color2' | 'emblem' | 'city_skin' | 'station_skin';

export interface EmpireEditorProps {
  roomId: string;
  snap: RoomSnapshot;
  myUserId?: string;
  /** Effective starting-world choice (optimistic-aware). */
  myChoice: string | null;
  /** Identity is locked once the game starts; the names list shows read-only. */
  started: boolean;
  empireName: string;
  onEmpireName: (v: string) => void;
  bio: string;
  onBio: (v: string) => void;
  onSaveEmpire: () => void;
  /** Show "Saved" next to the button. */
  saved: boolean;
  onPickFlag: (field: FlagField, value: string | null) => void;
  onPickBody: (bodyId: string | null) => void;
  namePools: NamePools;
  onSaveNamePools: (next: NamePools) => Promise<void> | void;
  pastBanks: PastNameBank[];
}

export function RoomEmpireEditor(p: EmpireEditorProps) {
  useI18n();
  const nameId = useId();
  const bioId = useId();
  return (
    <div className="rl-editor">
      <form
        className="rl-ed"
        onSubmit={(e) => { e.preventDefault(); p.onSaveEmpire(); }}
      >
        <div className="rl-fld">
          <label htmlFor={nameId}>{t('roomlobby.empireName')}</label>
          <input
            id={nameId}
            className="rl-input"
            type="text"
            maxLength={40}
            value={p.empireName}
            onChange={(e) => p.onEmpireName(e.target.value)}
            placeholder={t('roomlobby.empirePlaceholder')}
          />
        </div>
        <div className="rl-fld">
          <label htmlFor={bioId}>{t('roomlobby.bio')}</label>
          <textarea
            id={bioId}
            className="rl-input rl-textarea"
            maxLength={1000}
            value={p.bio}
            onChange={(e) => p.onBio(e.target.value)}
            placeholder={t('roomlobby.bioPlaceholder')}
          />
        </div>
        <div className="rl-row">
          <button type="submit" className="rl-btn rl-btn--gold rl-btn--sm">{t('roomlobby.saveEmpire')}</button>
          <span className="rl-saved" role="status">{p.saved ? t('roomlobby.saved') : ''}</span>
        </div>
      </form>

      <FactionFlagPicker snap={p.snap} myUserId={p.myUserId} onPick={p.onPickFlag} />

      <StartingBodyPicker snap={p.snap} myUserId={p.myUserId} myChoice={p.myChoice} onPick={p.onPickBody} />

      {/* Last but one, and collapsed by default. It is the longest step and
          the only optional one -- a player who ignores it still gets ten
          named, portrait'd, trait'd officers on the first tick. */}
      <div className="rl-ed">
        <CaptainRosterPicker roomId={p.roomId} />
      </div>

      {/* CUSTOM NAMES. Pre-game because that is when you are deciding
          what your empire is — and because these lists feed generators
          that start running the moment the match does. Editable later
          too: the profile endpoint syncs pools into a running game. */}
      <details className="rl-ed rl-names">
        <summary className="rl-ed__sum">
          {t('roomlobby.names.title')} <span className="rl-ed__opt">{t('roomlobby.names.optional')}</span>
        </summary>
        <p className="rl-hint">{t('roomlobby.names.desc')}</p>
        <NamePoolEditor value={p.namePools} onSave={p.onSaveNamePools} disabled={p.started} pastBanks={p.pastBanks} />
      </details>
    </div>
  );
}

// ---------- Faction color picker (two-tone, §5) ----------

/** Grey used to mark a swatch as unavailable. */
const TAKEN_INK = 'rgba(150, 168, 184, 0.85)';

export function FactionFlagPicker({
  snap, myUserId, onPick,
}: {
  snap: RoomSnapshot;
  myUserId?: string;
  onPick: (field: FlagField, value: string | null) => void;
}) {
  useI18n();
  // Commission state gates the premium emblem wing below. UI-only — the
  // lobby endpoint re-checks the entitlement on save.
  const { user } = useAuth();
  const isPremium = !!user?.is_premium;
  const me = myUserId ? snap.members.find(m => m.userId === myUserId) : undefined;
  const myColor = me?.color ?? null;
  const myColor2 = me?.color2 ?? null;
  const myEmblem = me?.emblem ?? null;
  const primaryId = useId();
  const secondaryId = useId();
  const emblemId = useId();

  // Other members' primaries — used to gray out swatches that are too
  // close (mirrors the server's 409 'color_taken' check so the player
  // rarely hits the error path).
  const otherPrimaries = snap.members
    .filter(m => m.userId !== myUserId && m.color)
    .map(m => ({ color: m.color as string, name: m.empire_name || m.displayName }));

  // Emblems taken by OTHER members. Exact match — a shape is either
  // yours or theirs, there is no "close enough" the way colour has.
  const takenEmblems = new Map<string, string>();
  for (const m of snap.members) {
    if (m.userId !== myUserId && m.emblem) {
      takenEmblems.set(m.emblem, m.empire_name || m.displayName);
    }
  }

  return (
    <div className="rl-ed">
      <h3 className="rl-ed__h">{t('roomlobby.flag.title')}</h3>
      <p className="rl-hint">{t('roomlobby.flag.desc')}</p>

      <div className="rl-lbl" id={primaryId}>{t('roomlobby.flag.primary')}</div>
      <div className="rl-swatches" role="group" aria-labelledby={primaryId}>
        {FACTION_COLOR_CHOICES.map(c => {
          // Exact match only. This used to grey out anything within 90
          // sRGB units of a rival's pick, which meant a few seated
          // players wiped out most of the grid — the rule ran the lobby
          // out of colours long before the palette did.
          const clash = otherPrimaries.find(o => o.color.toLowerCase() === c.toLowerCase());
          const selected = myColor === c;
          // Own pick is never "taken" by yourself.
          const taken = !!clash && !selected;
          const title = taken ? t('roomlobby.flag.colorTaken', { name: clash!.name }) : selected ? t('roomlobby.flag.clear') : c;
          return (
            <button
              key={c}
              type="button"
              disabled={taken}
              className={`rl-swatch ${selected ? 'is-selected' : ''} ${taken ? 'is-taken' : ''}`}
              aria-pressed={selected}
              aria-label={title}
              title={title}
              onClick={() => onPick('color', selected ? null : c)}
            >
              <span className="rl-swatch__c" style={{ background: c }} />
            </button>
          );
        })}
      </div>

      <div className="rl-lbl" id={secondaryId}>{t('roomlobby.flag.secondary')}</div>
      <div className="rl-swatches" role="group" aria-labelledby={secondaryId}>
        {FACTION_COLOR_CHOICES.map(c => {
          const selected = myColor2 === c;
          // Secondary is decoration only — meaning must stay in the
          // primary — so it's a free pick: no taken states here.
          const title = selected ? t('roomlobby.flag.clearTrim') : c;
          return (
            <button
              key={c}
              type="button"
              className={`rl-swatch ${selected ? 'is-selected' : ''}`}
              aria-pressed={selected}
              aria-label={title}
              title={title}
              onClick={() => onPick('color2', selected ? null : c)}
            >
              <span className="rl-swatch__c" style={{ background: c }} />
            </button>
          );
        })}
      </div>

      <div className="rl-lbl" id={emblemId}>{t('roomlobby.flag.emblem')}</div>
      <div className="rl-swatches" role="group" aria-labelledby={emblemId}>
        {[...EMBLEM_IDS, ...PREMIUM_EMBLEM_IDS, ...EARNED_EMBLEM_IDS].map(id => {
          const selected = myEmblem === id;
          const takenBy = takenEmblems.get(id);
          // Premium emblems render in the grid for everyone — locked, not
          // hidden. A closet nobody can see sells nothing; a lock you can
          // hover is the storefront. EARNED emblems (0176) show the same
          // way, but money never opens them: only doing the thing does.
          const earnedLocked = (EARNED_EMBLEM_IDS as string[]).includes(id) && !(user?.emblem_grants ?? []).includes(id);
          const locked = earnedLocked || (!isPremium && (PREMIUM_EMBLEM_IDS as string[]).includes(id));
          const taken = !!takenBy && !selected;
          const title = earnedLocked ? t('roomlobby.flag.earnedEmblem', { name: EMBLEM_NAMES[id] })
            : locked ? t('roomlobby.flag.premiumEmblem', { name: EMBLEM_NAMES[id] })
            : taken ? t('roomlobby.flag.emblemTaken', { who: takenBy ?? '', name: EMBLEM_NAMES[id] })
            : selected ? t('roomlobby.flag.clear') : EMBLEM_NAMES[id];
          return (
            <button
              key={id}
              type="button"
              disabled={taken || locked}
              // The emblem draws in the player's own primary so the grid
              // previews the finished flag rather than a generic icon
              // sheet — you are choosing a shape for YOUR colours.
              // A TAKEN emblem gets the same treatment as a taken
              // swatch: drained to grey, so it reads as unavailable
              // rather than as a dimmer shade of your own colour. LOCKED
              // (premium) is deliberately left tinted and only softened —
              // it's a storefront, not a refusal, and greying it out
              // would sell it less.
              className={`rl-emblem ${selected ? 'is-selected' : ''} ${taken ? 'is-taken' : ''} ${locked ? 'is-locked' : ''}`}
              style={{
                color: selected ? '#fff' : taken ? TAKEN_INK : (myColor || 'var(--mp-text, #cfd8e3)'),
                background: selected ? (myColor || '#4ecdc4') : undefined,
              }}
              aria-pressed={selected}
              aria-label={title}
              title={title}
              onClick={() => onPick('emblem', selected ? null : id)}
            >
              <FactionEmblem emblem={id} fallbackKey={id} size={22} />
            </button>
          );
        })}
      </div>

      {!isPremium && (
        <div className="rl-upsell">
          <CommissionFlagView />
          <span>
            {t('roomlobby.flag.upsell', {
              lines: COMMISSION_LINES, name: t('hangar.commissionName'),
              discord: tk('roomlobby.flag.discord', COMMISSION_DISCORD),
              rule: tk('roomlobby.flag.rule', COMMISSION_NO_GAMEPLAY),
            })}
          </span>
          {/* The app does not sell it: its button opens the website in the
              phone's browser (openCommissionInBrowser). */}
          {isAndroidApp() ? (
            <button
              type="button"
              className="rl-btn rl-btn--sm rl-btn--quiet"
              onClick={() => openCommissionInBrowser('lobby-flag')}
            >
              {t('mp.commission.inBrowser', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
            </button>
          ) : (
            <button
              type="button"
              className="rl-btn rl-btn--sm rl-btn--quiet"
              onClick={() => {
                logCommission('lobby-flag', 'click');
                void startCommissionCheckout('lobby-flag').then(url => {
                  if (url) window.location.assign(url);
                });
              }}
            >
              {t('feed.buy', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
            </button>
          )}
        </div>
      )}

      {myColor && (
        <div className="rl-flagpreview">
          {t('roomlobby.flag.preview')}
          <span
            className="rl-flagpreview__chip"
            style={{ background: `linear-gradient(135deg, ${myColor} 0%, ${myColor} 68%, ${myColor2 || deriveSecondary(myColor)} 68%)` }}
          >
            {/* Emblem sits ON the flag, in ink chosen for contrast against
                the primary — the same call the in-game chips make, so what
                you see here is what the scoreboard shows. */}
            {myEmblem && (
              <FactionEmblem emblem={myEmblem} fallbackKey={myUserId ?? 'me'} size={16}
                             color={emblemInk(myColor)} />
            )}
          </span>
          {!myColor2 && <span>{t('roomlobby.flag.autoTrim')}</span>}
          {!myEmblem && <span>{t('roomlobby.flag.noEmblem')}</span>}
        </div>
      )}

      {/* Colony / station style for THIS game (0154). Null = the account
          default from the Hangar, which is what the tiles show lit. */}
      <div className="rl-lbl">{t('hangar.skins.title')}</div>
      <SkinPicker
        city={me?.city_skin ?? null}
        station={me?.station_skin ?? null}
        fallbackCity={user?.city_skin ?? null}
        fallbackStation={user?.station_skin ?? null}
        primary={myColor}
        secondary={myColor2}
        holder={isPremium}
        surface="skins"
        onPick={onPick}
      />
      {(me?.city_skin || me?.station_skin) && (
        <button type="button" className="skp-reset"
                onClick={() => { onPick('city_skin', null); onPick('station_skin', null); }}>
          {t('roomlobby.flag.useDefault')}
        </button>
      )}
    </div>
  );
}

// ---------- Starting body picker ----------

export function StartingBodyPicker({
  snap, myUserId, myChoice, onPick,
}: {
  snap: RoomSnapshot;
  myUserId?: string;
  /** Effective choice (optimistic-aware) from the parent. */
  myChoice: string | null;
  /** Pick / un-pick handler (optimistic + PATCH) owned by the parent. */
  onPick: (bodyId: string | null) => void;
}) {
  useI18n();
  const options = snap.starting_body_options ?? [];
  if (!options.length) return null;

  // Map of body id -> userId who claimed it (so we can show "taken").
  // Built from the server snapshot for OTHER players, then patched with
  // the local player's optimistic choice so the highlight is instant and
  // never shows a stale double-claim while the PATCH is in flight.
  const claimedBy = new Map<string, string>();
  for (const m of snap.members) {
    if (m.chosen_starting_body) claimedBy.set(m.chosen_starting_body, m.userId);
  }
  if (myUserId) {
    for (const [bid, uid] of Array.from(claimedBy)) {
      if (uid === myUserId) claimedBy.delete(bid);
    }
    if (myChoice) claimedBy.set(myChoice, myUserId);
  }

  const pick = onPick;

  return (
    <div className="rl-ed">
      <h3 className="rl-ed__h">{t('roomlobby.capital.title')}</h3>
      <p className="rl-hint">{t('roomlobby.capital.desc')}</p>
      <div className="lobby-body-grid">
        {options.map(opt => {
          const taken = claimedBy.get(opt.id);
          const isMine = taken === myUserId;
          const isTaken = !!taken && !isMine;
          const ownerName = taken
            ? (snap.members.find(m => m.userId === taken)?.displayName ?? t('roomlobby.capital.someone'))
            : null;
          return (
            <button
              key={opt.id}
              type="button"
              className={`lobby-body-card ${isMine ? 'is-mine' : ''} ${isTaken ? 'is-taken' : ''}`}
              disabled={isTaken}
              aria-pressed={isMine}
              onClick={() => pick(isMine ? null : opt.id)}
              title={
                isMine ? t('roomlobby.capital.unclaim')
                : isTaken ? t('roomlobby.capital.claimedBy', { name: ownerName ?? '' })
                : t('roomlobby.claim')
              }
            >
              <div className="lobby-body-card__name">{opt.name}</div>
              <div className="lobby-body-card__sub">
                {opt.type}{opt.parent && opt.parent !== 'sol' ? ` · ${opt.parent_name ?? opt.parent}` : ''}
              </div>
              <div className="lobby-body-card__yields">
                {opt.yield.metal > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.M }}>M{opt.yield.metal}</span>}
                {/* no F — fuel is dead (DESIGN-identity-economy.md §1.1) */}
                {/* C = credits (server field is still 'gold') */}
                {opt.yield.gold > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.C }}>C{opt.yield.gold}</span>}
                {opt.yield.science > 0 && <span style={{ color: RESOURCE_LETTER_COLORS.S }}>{resourceLetter('S')}{opt.yield.science}</span>}
              </div>
              {isMine && <div className="lobby-body-card__tag">{t('roomlobby.capital.yours')}</div>}
              {isTaken && <div className="lobby-body-card__tag is-taken">{ownerName}</div>}
            </button>
          );
        })}
      </div>
      {!myChoice && (
        <p className="rl-hint rl-hint--italic">{t('roomlobby.capital.auto')}</p>
      )}
    </div>
  );
}
