// ============================================================================
// EndingPage — the end-of-game page (the after-action report).
//
// A page, not a card: it fills the viewport and scrolls. From the top:
//
//   verdict band   VICTORY (teal) for the winner, GAME OVER (gold) for
//                  everyone else; the winner's emblem, name and how they won
//   your empire    place, five stats with ranks (only if you had an empire)
//   standings      winner first; YOU and OUT tags
//   superlatives   War / Empire / Society, from the awards the server found
//   the shape of   six totals, three line charts, the three biggest fights
//   the Commission one calm plug, only for an empire that survived to the end
//   actions        the match film, back to the lobby
//
// The page is presentational: it is handed `meta` (what the provider already
// knows, enough for the verdict), `status` + `data` (the full report from
// GET /api/games/:id/ending) and callbacks. EndingScreen.tsx does the fetching
// and the Commission bookkeeping; the dev preview (/?ending=<id>) feeds it a
// bundled fixture. While the report loads, or if it never comes, the verdict
// band is built from `meta` alone so the player always sees the result at once.
//
// Every word goes through the catalog (ending.* plus the existing mp.* keys);
// every number through fmtNumber, so Portuguese reads 1.234.
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FactionEmblem } from '../components/FactionEmblem';
import { DEFAULT_SHIP_ICONS, ShipIcon, ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import { deriveSecondary } from '../game/colorUtils';
import type { EndingAwardId, EndingFaction, EndingPayload } from './endingTypes';
import {
  AwardCardModel, awardGroups, battleSegments, durationParts, hasSeries, holdingsShare,
  myStats, peakLeader, Rank, verdictKind, victoryWay, viewerOf,
} from './endingModel';
import { EndingChart } from './EndingCharts';
import {
  COMMISSION_CITY_SKINS, COMMISSION_EMBLEMS, COMMISSION_STATION_SKINS, COMMISSION_STRUCTURE_LOOKS,
} from './commission';
import { commissionPhrases } from './CommissionMoments';
import { fmtNumber, getLang, Key, PluralKey, t, tn, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './EndingPage.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** What the game provider already knows once a game is over. Enough for the
 *  verdict, so the page can say who won before (or without) the full report. */
export interface EndingMeta {
  winnerFactionId: string | null;
  winnerName: string | null;
  victoryType: string | null;
  myFactionId: string | null;
  factions: ReadonlyArray<{
    id: string; name: string; color: string;
    color2?: string | null; emblem?: string | null; status: string;
  }>;
}

export interface EndingPlug {
  /** False in the Android app: the button opens the website in the phone's browser. */
  sellable: boolean;
  /** The plug scrolled into view: log the view, remember it was shown. */
  onView: () => void;
  onBuy: () => void;
}

export interface EndingPageProps {
  gameId: string;
  meta: EndingMeta;
  status: 'loading' | 'ready' | 'failed';
  data: EndingPayload | null;
  onReturn: () => void;
  /** Renders the match film; omit to hide the button (not offered). */
  renderFilm?: (gameId: string) => React.ReactNode;
  /** Present only when the Commission may be shown to this viewer. */
  plug?: EndingPlug | null;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** "1st" in English, "1º" in Portuguese: the catalog owns the suffix. */
function ord(n: number): string {
  const rule = new Intl.PluralRules(getLang(), { type: 'ordinal' }).select(n);
  return tk(`ending.ord.${rule}`, '{n}th', { n: fmtNumber(n) });
}

const rankText = (r: Rank): string => `${r.tied ? '=' : ''}${ord(r.rank)}`;

/** The brand mark in the top bar. A constant, not JSX text: it is a name. */
const BRAND = 'ORBITAL';

const AWARD_GLYPH: Record<EndingAwardId, string> = {
  warmonger: 'M5 19L17 7M14 7h3v3M19 19L7 7M10 7H7v3',
  ace: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 7v10M7 12h10',
  heavy_hitter: 'M12 3l2 6 6 1-5 4 2 6-5-3-5 3 2-6-5-4 6-1z',
  iron_wall: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  last_stand: 'M6 21V4M6 5h11l-3 4 3 4H6',
  instigator: 'M12 3c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z',
  landlord: 'M12 5a7 7 0 100 14 7 7 0 000-14zM3 12c0-2 4-3 9-3s9 1 9 3-4 3-9 3-9-1-9-3z',
  treasurer: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 7v10M9 10h5a1.5 1.5 0 010 3h-4a1.5 1.5 0 000 3h5',
  scholar: 'M4 6c3-1 6-1 8 1 2-2 5-2 8-1v12c-3-1-6-1-8 1-2-2-5-2-8-1zM12 7v12',
  shipwright: 'M12 3l6 14-6-3-6 3zM12 14v7',
  merchant: 'M5 8h13M15 5l3 3-3 3M19 16H6M9 13l-3 3 3 3',
  statesman: 'M3 20h18M5 20V10M9 20V10M15 20V10M19 20V10M3 10l9-6 9 6z',
};

/** The catalog keys behind each award: the words live in the catalog, the
 *  table only names them (so nothing here freezes a language). */
const AWARD_KEYS: Record<EndingAwardId, { title: Key; blurb: Key; unit: PluralKey }> = {
  warmonger: { title: 'ending.award.warmonger.title', blurb: 'ending.award.warmonger.blurb', unit: 'ending.award.warmonger.unit' },
  ace: { title: 'ending.award.ace.title', blurb: 'ending.award.ace.blurb', unit: 'ending.award.ace.unit' },
  heavy_hitter: { title: 'ending.award.heavy_hitter.title', blurb: 'ending.award.heavy_hitter.blurb', unit: 'ending.award.heavy_hitter.unit' },
  iron_wall: { title: 'ending.award.iron_wall.title', blurb: 'ending.award.iron_wall.blurb', unit: 'ending.award.iron_wall.unit' },
  last_stand: { title: 'ending.award.last_stand.title', blurb: 'ending.award.last_stand.blurb', unit: 'ending.award.last_stand.unit' },
  instigator: { title: 'ending.award.instigator.title', blurb: 'ending.award.instigator.blurb', unit: 'ending.award.instigator.unit' },
  landlord: { title: 'ending.award.landlord.title', blurb: 'ending.award.landlord.blurb', unit: 'ending.award.landlord.unit' },
  treasurer: { title: 'ending.award.treasurer.title', blurb: 'ending.award.treasurer.blurb', unit: 'ending.award.treasurer.unit' },
  scholar: { title: 'ending.award.scholar.title', blurb: 'ending.award.scholar.blurb', unit: 'ending.award.scholar.unit' },
  shipwright: { title: 'ending.award.shipwright.title', blurb: 'ending.award.shipwright.blurb', unit: 'ending.award.shipwright.unit' },
  merchant: { title: 'ending.award.merchant.title', blurb: 'ending.award.merchant.blurb', unit: 'ending.award.merchant.unit' },
  statesman: { title: 'ending.award.statesman.title', blurb: 'ending.award.statesman.blurb', unit: 'ending.award.statesman.unit' },
};

const DUR_KEY: Record<'days' | 'hours' | 'minutes', PluralKey> = {
  days: 'ending.dur.days', hours: 'ending.dur.hours', minutes: 'ending.dur.minutes',
};

const GROUP_KEY = {
  war: 'ending.group.war', empire: 'ending.group.empire', society: 'ending.group.society',
} as const;

const STAT_KEY = {
  holdings: 'ending.stat.holdings', kills: 'ending.stat.kills', shipsLost: 'ending.stat.shipsLost',
  shipsBuilt: 'ending.stat.shipsBuilt', trades: 'ending.stat.trades',
} as const;

const Emblem = ({ f, size, dim }: {
  f: { id: string; emblem?: string | null; color: string }; size: number; dim?: boolean;
}) => (
  <span className="ep-emb" style={{ width: size, height: size, color: f.color, opacity: dim ? 0.45 : 1 }}>
    <FactionEmblem emblem={f.emblem} fallbackKey={f.id} size={size} />
  </span>
);

const YouTag = () => <span className="ep-tag ep-tag--you">{t('ending.tag.you')}</span>;

function SectionHead({ title, sub, id }: { title: string; sub?: string; id: string }) {
  return (
    <div className="ep-sechead">
      <h2 id={id}>{title}</h2>
      <i aria-hidden />
      {sub && <span>{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function EndingPage({ gameId, meta, status, data, onReturn, renderFilm, plug }: EndingPageProps) {
  useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const [showFilm, setShowFilm] = useState(false);

  // Focus lands on the verdict, not on whatever the map left focused.
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, []);

  // Tab stays inside the page: it covers the map, and the map's controls are
  // still in the DOM behind it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !rootRef.current) return;
    const items = Array.from(rootRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea',
    )).filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === headRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };

  const ready = status === 'ready' && data != null;
  const me: EndingFaction | null = ready ? viewerOf(data.factions) : null;
  const meId = ready ? (me?.id ?? null) : meta.myFactionId;
  const winnerId = ready ? data.game.winnerFactionId : meta.winnerFactionId;
  const winnerFull = ready ? data.factions.find(f => f.id === winnerId) ?? null : null;
  const winnerMeta = meta.factions.find(f => f.id === winnerId) ?? null;
  const winner = winnerFull ?? winnerMeta;
  const winnerName = winner?.name ?? meta.winnerName;
  const kind = verdictKind(winnerId, meId);
  const victory = kind === 'victory';
  const victoryType = ready ? data.game.victoryType : meta.victoryType;
  const way = victoryWay(victoryType);

  const meParty = meId ? (ready ? me : meta.factions.find(f => f.id === meId)) ?? null : null;

  const verdictLine = (): string => {
    if (!winnerName) return victoryType === 'annihilation' ? t('mp.provider.noSurvivor') : t('mp.provider.noWinner');
    switch (way) {
      case 'engineering': return t('mp.provider.vl.engineering');
      case 'domination': return t('mp.provider.vl.domination');
      case 'chancellor': return t('mp.provider.vl.chancellor');
      case 'annihilation': return t('ending.verdict.annihilation');
      default: return t('ending.verdict.other');
    }
  };

  const toggleFilm = () => {
    setShowFilm(v => !v);
  };
  useEffect(() => {
    if (!showFilm) return;
    let calm = false;
    try { calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* no matchMedia */ }
    filmRef.current?.scrollIntoView?.({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
  }, [showFilm]);

  // ---- the report-dependent sections ----
  const stats = ready && me ? myStats(data.factions, me) : null;
  const groups = useMemo(() => (ready ? awardGroups(data.awards, data.factions) : []), [ready, data]);
  const dur = ready ? durationParts(data.game.durationMs) : null;

  let sec = 0;
  const rise = () => ({ className: 'ep-sec', style: { ['--i' as string]: sec++ } as React.CSSProperties });

  return (
    <div
      ref={rootRef}
      className="ep"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ep-headline"
      aria-busy={status === 'loading'}
      onKeyDown={onKeyDown}
    >
      <div className="ep-wrap">
        <div className="ep-brandbar"><b>{BRAND}</b><span>{t('ending.brand.sub')}</span></div>

        {/* ===================== Verdict ===================== */}
        <header className={`ep-hero${(ready && me) || (status === 'loading' && meParty) ? '' : ' ep-hero--solo'}`}>
          <div className="ep-verdict">
            {ready && (
              <div className="ep-eyebrow">
                {data.game.name}
                {dur && <> <span aria-hidden>·</span> {tn(DUR_KEY[dur.unit], dur.n)}</>}
              </div>
            )}
            <h1
              id="ep-headline"
              ref={headRef}
              tabIndex={-1}
              className={`ep-headline ${victory ? 'is-victory' : 'is-over'}`}
            >{victory ? t('mp.provider.victory') : t('mp.provider.gameOver')}</h1>
            {winnerName ? (
              <div className="ep-winner">
                {winner && <Emblem f={winner} size={58} />}
                <div className="ep-winner__text">
                  <div className="ep-winner__name">
                    {winnerName}
                    {winnerId != null && winnerId === meId && <> <YouTag /></>}
                  </div>
                  <div className="ep-winner__how">{verdictLine()}</div>
                </div>
              </div>
            ) : (
              <div className="ep-winner__how">{verdictLine()}</div>
            )}
            {ready && (
              <div className="ep-chips">
                <Chip n={data.game.currentTick} k="ending.chip.ticks" />
                <Chip n={data.game.empires} k="ending.chip.empires" />
                <Chip n={data.totals.battles} k="ending.chip.battles" />
                <Chip n={data.totals.shipsLost} k="ending.chip.hullsLost" />
              </div>
            )}
            {status === 'loading' && <div className="ep-skel ep-skel--chips" aria-hidden />}
          </div>

          {ready && me && stats && (
            <aside className="ep-panel ep-you" aria-labelledby="ep-you-h">
              <div className="ep-eyebrow" id="ep-you-h">{t('ending.you.eyebrow')}</div>
              <div className="ep-you__head">
                <Emblem f={me} size={54} />
                <div className="ep-you__id">
                  <div className="ep-you__name">{me.name}</div>
                  <div className="ep-you__status">
                    {me.finalStatus === 'active'
                      ? t('ending.you.standing')
                      : me.eliminatedAtTick != null
                        ? t('ending.you.knockedOut', { n: fmtNumber(me.eliminatedAtTick) })
                        : t('ending.you.knockedOutUnknown')}
                  </div>
                </div>
                <div className="ep-you__place">
                  <div className={`ep-you__ord${me.place === 1 ? ' is-first' : ''}`}>{ord(me.place)}</div>
                  <div className="ep-you__of">{tn('ending.you.of', data.factions.length)}</div>
                </div>
              </div>
              <div role="list">
                {stats.map(s => (
                  <div className="ep-statrow" role="listitem" key={s.id}>
                    <span>{t(STAT_KEY[s.id])}</span>
                    <span className="ep-num ep-statrow__v">{fmtNumber(s.value)}</span>
                    <span className="ep-rank">{s.rank ? rankText(s.rank) : ''}</span>
                  </div>
                ))}
              </div>
            </aside>
          )}
          {status === 'loading' && meParty && (
            <aside className="ep-panel ep-you" aria-hidden>
              <div className="ep-skel ep-skel--line" />
              <div className="ep-skel ep-skel--block" />
              <div className="ep-skel ep-skel--block" />
              <div className="ep-skel ep-skel--block" />
            </aside>
          )}
        </header>

        {showFilm && renderFilm && (
          <div className="ep-film" ref={filmRef}>{renderFilm(gameId)}</div>
        )}

        {status === 'loading' && (
          <div className="ep-skelstack" aria-hidden>
            <div className="ep-skel ep-skel--panel" />
            <div className="ep-skel ep-skel--panel" />
          </div>
        )}
        {status === 'loading' && <div className="ep-sr" role="status">{t('ending.loading')}</div>}

        {ready && (
          <>
            {/* ===================== Standings ===================== */}
            <section {...rise()} aria-labelledby="ep-standings-h">
              <SectionHead id="ep-standings-h" title={t('ending.standings.title')} sub={t('ending.standings.sub')} />
              <Standings data={data} />
            </section>

            {/* ===================== Superlatives ===================== */}
            {groups.length > 0 && (
              <section {...rise()} aria-labelledby="ep-awards-h">
                <SectionHead id="ep-awards-h" title={t('ending.awards.title')} sub={t('ending.awards.sub')} />
                {groups.map(g => (
                  <div key={g.group}>
                    <div className="ep-grp">{t(GROUP_KEY[g.group])}</div>
                    <div className="ep-awgrid">
                      {g.cards.map(c => <AwardCard key={c.id} c={c} />)}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* ===================== Shape of the game ===================== */}
            <section {...rise()} aria-labelledby="ep-shape-h">
              <SectionHead
                id="ep-shape-h"
                title={t('ending.shape.title')}
                sub={tn('ending.shape.sub', data.game.currentTick, { shots: fmtNumber(data.totals.shots) })}
              />
              <div className="ep-tiles">
                <Tile n={data.totals.battles} l={t('ending.tile.battles')} />
                <Tile n={data.totals.shots} l={t('ending.tile.shots')} />
                <Tile n={data.totals.shipsLost} l={t('ending.tile.hullsLost')} />
                <Tile n={data.totals.shipsBuilt} l={t('ending.tile.hullsBuilt')} />
                <Tile n={data.totals.trades} l={t('ending.tile.trades')} />
                <Tile n={data.totals.wars} l={t('ending.tile.wars')} />
              </div>
              {hasSeries(data) && <Charts data={data} />}
              {data.battles.length > 0 && <Battles data={data} />}
            </section>
          </>
        )}

        {/* ===================== The Commission ===================== */}
        {plug && !showFilm && status !== 'loading' && (
          <section {...rise()} aria-labelledby="ep-cm-h">
            <SectionHead id="ep-cm-h" title={t('mp.endgame.title')} />
            <Plug plug={plug} me={meParty} />
          </section>
        )}

        {/* ===================== Actions ===================== */}
        <div className="ep-actions">
          {renderFilm && (
            <button type="button" className="ep-btn ep-btn--gold" aria-expanded={showFilm} onClick={toggleFilm}>
              {showFilm ? t('mp.provider.hideFilm') : t('mp.provider.watchFilm')}
            </button>
          )}
          <button type="button" className="ep-btn ep-btn--ghost" onClick={onReturn}>{t('mp.provider.returnLobby')}</button>
        </div>
        {ready && (
          <div className="ep-foot">{t('ending.foot', { name: data.game.name, id: data.game.id })}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Chip({ n, k }: { n: number; k: PluralKey }) {
  // The label key carries no {n}: the figure is set in its own face.
  return (
    <span className="ep-chip"><b className="ep-num">{fmtNumber(n)}</b>{tn(k, n)}</span>
  );
}

function Tile({ n, l }: { n: number; l: string }) {
  return (
    <div className="ep-panel ep-tile">
      <div className="ep-tile__n ep-num">{fmtNumber(n)}</div>
      <div className="ep-tile__l">{l}</div>
    </div>
  );
}

function Standings({ data }: { data: EndingPayload }) {
  const max = Math.max(1, ...data.factions.map(f => f.final.holdings));
  return (
    <div className="ep-panel ep-tbl" role="table" aria-label={t('ending.standings.title')}>
      <div className="ep-trow ep-thead" role="row">
        <span role="columnheader">{t('ending.col.rank')}</span>
        <span role="columnheader">{t('ending.col.empire')}</span>
        <span role="columnheader" className="ep-r">{t('ending.col.worlds')}</span>
        <span role="columnheader" className="ep-r">{t('ending.col.ships')}</span>
        <span role="columnheader" className="ep-r ep-hide-s">{t('ending.col.research')}</span>
        <span role="columnheader" className="ep-r ep-hide-s">{t('ending.col.credits')}</span>
      </div>
      {data.factions.map(f => {
        const out = f.finalStatus !== 'active';
        return (
          <div key={f.id} role="row" className={`ep-trow${f.isMe ? ' is-me' : ''}${out ? ' is-out' : ''}`}>
            <span role="cell" className={`ep-place${f.place === 1 ? ' is-first' : ''}`}>{fmtNumber(f.place)}</span>
            <div role="cell" className="ep-who">
              <Emblem f={f} size={30} dim={out} />
              <div className="ep-who__main">
                <div className="ep-who__line">
                  <span className="ep-who__name">{f.name}</span>
                  {f.isWinner && <span className="ep-tag ep-tag--win">{t('ending.tag.winner')}</span>}
                  {f.isMe && <YouTag />}
                  {out && (
                    <span className="ep-tag">
                      {f.eliminatedAtTick != null ? t('ending.tag.out', { n: fmtNumber(f.eliminatedAtTick) }) : t('ending.tag.outUnknown')}
                    </span>
                  )}
                </div>
                <div className="ep-bar" aria-hidden>
                  <div style={{ width: `${holdingsShare(f.final.holdings, max)}%`, background: f.color }} />
                </div>
              </div>
            </div>
            <span role="cell" className="ep-num ep-r">{fmtNumber(f.final.holdings)}</span>
            <span role="cell" className="ep-num ep-r">{fmtNumber(f.final.ships)}</span>
            <span role="cell" className="ep-num ep-r ep-hide-s">{fmtNumber(f.final.techs)}</span>
            <span role="cell" className="ep-num ep-r ep-hide-s">{fmtNumber(f.final.credits)}</span>
          </div>
        );
      })}
    </div>
  );
}

function AwardCard({ c }: { c: AwardCardModel }) {
  const k = AWARD_KEYS[c.id];
  const cls = c.ship?.shipClass;
  const shipText = c.ship
    ? (() => {
      const className = cls ? tk(`data.ship.${cls}.name`, cls) : t('ending.award.shipUnknown');
      return c.ship.captainName
        ? t('ending.award.shipCapt', { name: c.ship.name, class: className, captain: c.ship.captainName })
        : t('ending.award.ship', { name: c.ship.name, class: className });
    })()
    : null;
  return (
    <article className="ep-panel ep-aw">
      <div className="ep-aw__stripe" style={{ background: c.winner.color }} />
      <div className="ep-aw__gl" aria-hidden>
        <svg viewBox="0 0 24 24"><path d={AWARD_GLYPH[c.id]} /></svg>
      </div>
      <h4 className="ep-aw__ttl">{t(k.title)}</h4>
      <div className="ep-aw__bl">{t(k.blurb)}</div>
      <div className={`ep-aw__val ep-num${c.mine ? ' is-mine' : ''}`}>{fmtNumber(c.value)}</div>
      <div className="ep-aw__unit">{tn(k.unit, c.value)}</div>
      {shipText && <div className="ep-aw__ship">{shipText}</div>}
      <div className="ep-aw__who">
        <i className="ep-aw__dot" style={{ background: c.winner.color }} aria-hidden />
        <span className="ep-aw__name">{c.winner.name}</span>
        {c.mine && <YouTag />}
      </div>
      {c.runnerUp && (
        <div className="ep-aw__ru">
          {c.runnerUp.tied
            ? t('ending.award.tied', { name: c.runnerUp.faction.name })
            : t('ending.award.runnerUp', { name: c.runnerUp.faction.name, n: fmtNumber(c.runnerUp.value) })}
        </div>
      )}
    </article>
  );
}

function Charts({ data }: { data: EndingPayload }) {
  const hold = peakLeader(data.factions, 'holdings');
  const ships = peakLeader(data.factions, 'ships');
  const cred = peakLeader(data.factions, 'credits');
  const first = data.series.ticks[0];
  const last = data.series.ticks[data.series.ticks.length - 1];
  const aria = (title: string) => t('ending.chart.aria', { title, from: fmtNumber(first), to: fmtNumber(last) });
  const title = {
    holdings: t('ending.chart.holdings.title'),
    ships: t('ending.chart.ships.title'),
    credits: t('ending.chart.credits.title'),
  };
  return (
    <div className="ep-charts">
      <EndingChart
        data={data} measure="holdings" crosses className="ep-chart--wide" height={280}
        title={title.holdings} aria={aria(title.holdings)}
        sub={`${hold ? tn('ending.chart.holdings.peak', hold.value, { name: hold.faction.name }) : ''} ${t('ending.chart.crossNote')}`.trim()}
      />
      <EndingChart
        data={data} measure="ships"
        title={title.ships} aria={aria(title.ships)}
        sub={ships ? tn('ending.chart.ships.peak', ships.value, { name: ships.faction.name }) : ''}
      />
      <EndingChart
        data={data} measure="credits"
        title={title.credits} aria={aria(title.credits)}
        sub={cred ? tn('ending.chart.credits.peak', cred.value, { name: cred.faction.name }) : ''}
      />
    </div>
  );
}

function Battles({ data }: { data: EndingPayload }) {
  const byId = new Map(data.factions.map(f => [f.id, f] as const));
  return (
    <section className="ep-panel ep-tbl ep-battles" aria-labelledby="ep-battles-h">
      <div className="ep-battles__head">
        <h3 id="ep-battles-h">{t('ending.battles.title')}</h3>
        <div className="ep-sub">{t('ending.battles.sub')}</div>
      </div>
      {data.battles.map(b => {
        const segs = battleSegments(b);
        const lossText = segs.map(s => `${byId.get(s.factionId)?.name ?? ''}: ${fmtNumber(s.shipsLost)}`).join(', ');
        const span = b.endedTick != null && b.endedTick !== b.startedTick
          ? `${t('ending.chart.tickShort', { n: fmtNumber(b.startedTick) })}–${t('ending.chart.tickShort', { n: fmtNumber(b.endedTick) })}`
          : t('ending.chart.tickShort', { n: fmtNumber(b.startedTick) });
        return (
          <div className="ep-battle" key={b.id}>
            <div className="ep-battle__id">
              <div className="ep-battle__name">
                {b.bodyName ? t('ending.battle.of', { name: b.bodyName }) : t('ending.battle.deepSpace')}
              </div>
              <div className="ep-num ep-battle__meta">{span} · {tn('ending.battle.shots', b.shots)}</div>
            </div>
            <div className="ep-battle__loss">
              <div className="ep-battle__lost">
                <span className="ep-num">{fmtNumber(b.shipsLost)}</span>
                <span>{tn('ending.battle.hullsLost', b.shipsLost)}</span>
              </div>
              <div className="ep-lossbar" role="img" aria-label={lossText}>
                {segs.map(s => {
                  const f = byId.get(s.factionId);
                  const tip = `${f?.name ?? ''}: ${fmtNumber(s.shipsLost)}`;
                  return <i key={s.factionId} style={{ width: `${s.pct}%`, background: f?.color ?? '#7a8ca0' }} title={tip} />;
                })}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The Commission plug
// ---------------------------------------------------------------------------

/** Standard lines against the Commission lines, per hull. The Commission row
 *  is the homage line (the letters the Shipwright leads with); the colony row
 *  uses V because the free colony ship (A) is the SAME Ark in every slot. */
const STD_ROW: ShipIconClass[] = ['colony', 'freighter', 'corvette', 'frigate', 'destroyer'];
const COM_ROW: Array<[ShipIconClass, ShipIconVariant]> = [
  ['colony', 'V'], ['freighter', 'V'], ['corvette', 'W'], ['frigate', 'S'], ['destroyer', 'Y'],
];

function Plug({ plug, me }: { plug: EndingPlug; me: { color: string; color2?: string | null } | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const onView = useRef(plug.onView);
  onView.current = plug.onView;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { onView.current(); return; }
    const io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) { onView.current(); io.disconnect(); }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const p1 = me?.color ?? '#9fb3c8';
  const p2 = me?.color2 || deriveSecondary(p1);
  const phrases = commissionPhrases();
  const facts = t('ending.cm.facts', {
    lines: phrases.lines, emblems: COMMISSION_EMBLEMS, city: COMMISSION_CITY_SKINS,
    station: COMMISSION_STATION_SKINS, looks: COMMISSION_STRUCTURE_LOOKS,
    discord: phrases.discord, noGameplay: phrases.noGameplay,
  });
  return (
    <div className="ep-cm" ref={ref} role="note">
      <div className="ep-cm__fleet" aria-hidden>
        <div className="ep-cm__row is-std">
          <span className="ep-cm__lab">{t('ending.cm.standard')}</span>
          {STD_ROW.map(cls => (
            <span className="ep-cm__sh" key={cls}><ShipIcon shipClass={cls} variant={DEFAULT_SHIP_ICONS[cls]} size={64} color={p1} color2={p2} /></span>
          ))}
        </div>
        <div className="ep-cm__row is-com">
          <span className="ep-cm__lab">{t('ending.cm.commission')}</span>
          {COM_ROW.map(([cls, v]) => (
            <span className="ep-cm__sh" key={cls}><ShipIcon shipClass={cls} variant={v} size={64} color={p1} color2={p2} /></span>
          ))}
        </div>
      </div>
      <div className="ep-cm__copy">
        <h3>{t('ending.cm.headline')}</h3>
        <p>{facts}</p>
        <div className="ep-cm__cta">
          <button type="button" className="ep-btn ep-btn--gold" onClick={plug.onBuy}>
            {plug.sellable ? t('mp.endgame.look') : t('mp.commission.inBrowser', { price: phrases.price })}
          </button>
          <span className="ep-num ep-cm__price">{t('ending.cm.priceOnce', { price: phrases.price })}</span>
        </div>
      </div>
    </div>
  );
}
