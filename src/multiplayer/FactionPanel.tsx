import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, MyFaction, Pact, PACT_LABELS, PactKind, tradesApi, warsApi, WarRow } from './api';
import { FlagChip } from '../components/FactionEmblem';
import { HOLDER_MARK } from './commission';
import { t, tk } from '../i18n/core';
import type { Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';

// The local twoToneChip helper is gone — FlagChip in
// components/FactionEmblem draws the same two-tone field plus the
// faction's emblem, and LobbyView now shares it, so a player's flag
// cannot render one way in the lobby and another in the match.

// Highest-tier pact wins for the at-a-glance WAR/ALLIED/NAP label.
// Ranked by how much it suppresses combat: defense_pact (full coverage)
// > nap (peace but no defense) > intel_share (info only, no combat
// suppression in the current rules). Players with NO active pact are
// at war by default — that's the implicit-war design.
const PACT_RANK: Record<PactKind, number> = {
  defense_pact: 3,
  nap: 2,
  intel_share: 1,
  // Bottom of the ladder because it suppresses no combat at all — a
  // joint construction pact is an economic tie, not a ceasefire. Two
  // factions can co-fund a gate and still be shooting at each other,
  // and the relation chip should say WAR when that is the truth.
  construction_pact: 0,
};

const STATUS_LABEL = {
  defense_pact: 'faction.chip.allied',
  // ☮ peace sign — the acronym "NAP" was opaque to playtesters;
  // glyph + the word "PEACE" reads as the intent at a glance and
  // matches the cool-cyan no-combat coloring.
  nap: 'faction.chip.peace',
  intel_share: 'faction.chip.intel',
  construction_pact: 'faction.chip.jointBuild',
  war: 'faction.chip.war',
  // No treaty and no declared war. Peace is the DEFAULT now (war has to
  // be declared), so "no pact" no longer means "at war" — this chip used
  // to fall back to WAR for every stranger, and a brand-new game showed
  // three wars nobody had declared.
  neutral: 'faction.chip.neutral',
  self: '',
} as const;

/** The chip's words, in the player's language. */
const statusText = (k: keyof typeof STATUS_LABEL): string => {
  const key = STATUS_LABEL[k];
  return key ? t(key) : '';
};

/** The drawer's long-form of the relation chip: the chip abbreviates,
 *  the drawer speaks in sentences. */
const RELATION_TEXT: Record<keyof typeof STATUS_LABEL, Key | ''> = {
  defense_pact: 'faction.rel.allied',
  nap: 'faction.rel.peace',
  intel_share: 'faction.rel.intel',
  // Says what it is AND what it is not — an economic tie that suppresses
  // no combat, which is the thing a player will otherwise assume.
  construction_pact: 'faction.rel.jointBuild',
  war: 'faction.rel.war',
  neutral: 'faction.rel.neutral',
  self: '',
};

const STATUS_COLOR: Record<keyof typeof STATUS_LABEL, string> = {
  defense_pact: '#6ee7b7',   // friendly green — full alliance
  nap: '#67e8f9',            // cool cyan — peace but not allied
  intel_share: '#a4b5c4',    // muted — info-only
  // Work yellow, the same colour the construction UI uses throughout —
  // and deliberately NOT a peace colour, because it is not one.
  construction_pact: '#ffb84d',
  war: '#ff5e5e',            // hostile red — a DECLARED, open war only
  neutral: '#8a9fb3',        // muted — no relationship either way
  self: 'var(--mp-fg-dim)',
};

// Per-resource tint for the income line — subtle, decoration only.

export function FactionPanel({
  gameId,
  onlineUserIds = [],
}: {
  gameId: string;
  /** User ids with a live socket right now, from the shell's room
   *  WebSocket. Defaults to empty so the panel still renders standalone
   *  (tests, any future mount that has no socket) — everyone simply
   *  reads as offline rather than the component throwing. */
  onlineUserIds?: string[];
}) {
  useI18n();
  // Set, not .includes() per row: the roster is small today but this is
  // inside a render that already runs on every poll.
  const onlineSet = useMemo(() => new Set(onlineUserIds), [onlineUserIds]);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [roster, setRoster] = useState<Faction[]>([]);
  const [pacts, setPacts] = useState<Pact[]>([]);
  const [wars, setWars] = useState<WarRow[]>([]);
  const [breaking, setBreaking] = useState<string | null>(null);
  const [breakError, setBreakError] = useState<string | null>(null);
  // WAR FROM THE DRAWER. Declaring lived only in Trade › Standing, while
  // this panel is where rivals are listed and where players looked for it
  // (QA battle test: the row drawer offered no action at all). Same API
  // and the same inline confirm as the Standing tab.
  const [warConfirm, setWarConfirm] = useState<string | null>(null);
  const [warBusy, setWarBusy] = useState<string | null>(null);
  const runWar = async (fid: string, fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } | null }>, failKey: Key) => {
    setWarBusy(fid);
    setBreakError(null);
    try {
      const res = await fn();
      if (!res.ok) setBreakError(apiErrorText(res.error, failKey));
      else await refresh();
    } catch {
      setBreakError(t(failKey));
    } finally {
      setWarBusy(null);
      setWarConfirm(null);
    }
  };
  /** Dyson progress rides on the factions payload so all three victory
   *  paths render from one fetch. Null on pre-Phase-B games. */
  const [dyson, setDyson] = useState<DysonProgress | null>(null);
  /** Which faction rows have their detail drawer open. */
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) => setOpenRows(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const tradesApiClient = useMemo(() => tradesApi(gameId), [gameId]);

  const refresh = useCallback(async () => {
    const [meRes, listRes, pactsRes, warsRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[]; dyson?: DysonProgress | null }>(`/api/games/${gameId}/factions`),
      tradesApiClient.listPacts(),
      warsApi(gameId).list(),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (listRes.ok) { setRoster(listRes.data.factions); setDyson(listRes.data.dyson ?? null); }
    if (pactsRes.ok) setPacts(pactsRes.data.pacts);
    if (warsRes.ok) setWars(warsRes.data.wars);
  }, [gameId, tradesApiClient]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 10_000);
    return () => clearInterval(iv);
  }, [refresh]);

  async function handleBreak(treatyId: string) {
    if (!window.confirm(t('faction.break.confirm'))) return;
    setBreaking(treatyId);
    setBreakError(null);
    const res = await tradesApiClient.breakTreaty(treatyId);
    setBreaking(null);
    if (!res.ok) {
      setBreakError(apiErrorText(res.error, 'faction.err.break'));
      return;
    }
    refresh();
  }

  if (!me) return <div className="mp-empty">{t('faction.loading')}</div>;

  // Build per-counterparty pact map for the diplomacy roster.
  const pactsByFaction = new Map<string, Pact[]>();
  for (const p of pacts) {
    for (const fid of p.counterparty_faction_ids) {
      const arr = pactsByFaction.get(fid) ?? [];
      arr.push(p);
      pactsByFaction.set(fid, arr);
    }
  }
  const topPactKind = (fid: string): PactKind | null => {
    const arr = pactsByFaction.get(fid);
    if (!arr || arr.length === 0) return null;
    return arr.reduce<PactKind | null>((best, p) => {
      if (!best) return p.kind;
      return PACT_RANK[p.kind] > PACT_RANK[best] ? p.kind : best;
    }, null);
  };

  // Threat order: the faction closest to winning reads first, not the
  // one that happened to take seat 0. Vote weight is the sort key because
  // it is the only stat that is itself a win condition.
  const ranked = [...roster].sort((a, b) => {
    const w = (weightOf(b) - weightOf(a));
    if (w !== 0) return w;
    return (b.bodies_owned ?? 0) - (a.bodies_owned ?? 0);
  });

  // My own scoreboard lives on the roster entry — /me doesn't carry the
  // derived fields. Fall back so the tracks render before the roster lands.
  const myScore = roster.find(f => f.id === me.id) ?? (me as unknown as Faction);
  const bodiesTotal = roster.find(f => (f.bodies_total ?? 0) > 0)?.bodies_total ?? 0;
  const systemsTotal = roster.find(f => (f.systems_total ?? 0) > 0)?.systems_total ?? 0;
  const claimed = roster.reduce((n, f) => n + (f.bodies_owned ?? 0), 0);
  const unclaimed = Math.max(0, bodiesTotal - claimed);
  // Domination is STRICTLY more than 60%, so the target is the first
  // integer above the fraction — 28 of 45, not 27. Mirrors room.js.
  const dominationTarget = bodiesTotal > 0 ? Math.floor(bodiesTotal * 0.6) + 1 : 0;
  const chamber = roster.reduce((n, f) => n + weightOf(f), 0);

  const leaderBy = (score: (f: Faction) => number): Faction | null =>
    ranked.reduce<Faction | null>((best, f) =>
      (!best || score(f) > score(best)) ? f : best, null);
  const domLeader = leaderBy(f => f.bodies_owned ?? 0);
  const senLeader = leaderBy(weightOf);
  const dysonOwner = dyson?.controller
    ? roster.find(f => f.id === dyson.controller) ?? null
    : null;

  return (
    <div className="fp">
      {/* ---------- territory: the shape of the game ---------- */}
      {bodiesTotal > 0 && (
        <section className="fp-sect">
          <div className="fp-sect__h">
            <span className="fp-lbl">{t('faction.territory')}</span>
            <span className="fp-lbl fp-lbl--dim">
              {t('faction.terr.count', { worlds: bodiesTotal, systems: systemsTotal })}
            </span>
          </div>
          <div className="fp-terrwrap">
            <div className="fp-terr">
              {ranked.filter(f => (f.bodies_owned ?? 0) > 0).map(f => {
                const n = f.bodies_owned ?? 0;
                const pct = (100 * n) / bodiesTotal;
                return (
                  <div
                    key={f.id}
                    style={{ width: `${pct}%`, background: f.color }}
                    title={t('faction.terr.owned', { name: f.name, n, total: bodiesTotal })}
                  >
                    {pct >= 7 && <span style={{ color: readableOn(f.color) }}>{n}</span>}
                  </div>
                );
              })}
              {unclaimed > 0 && (
                <div
                  className="fp-terr__free"
                  style={{ width: `${(100 * unclaimed) / bodiesTotal}%` }}
                  title={t('faction.terr.unclaimedTip', { n: unclaimed })}
                >
                  {unclaimed / bodiesTotal >= 0.14 && <span>{t('faction.terr.free', { n: unclaimed })}</span>}
                </div>
              )}
            </div>
            {/* Domination line. Left as a fraction of the whole bar so it
                lands on the same scale the segments use. */}
            <div
              className="fp-terr__tick"
              style={{ left: `${(100 * dominationTarget) / bodiesTotal}%` }}
              title={t('faction.terr.dominationTip', { n: dominationTarget })}
            />
          </div>
          <div className="fp-terrfoot">
            <span>{t('faction.terr.claimed', { n: claimed, total: bodiesTotal })}</span>
            <span className="fp-terrfoot__mid">{t('faction.terr.wins', { n: dominationTarget })}</span>
            <span>{t('faction.terr.unclaimed', { n: unclaimed })}</span>
          </div>
        </section>
      )}

      {/* ---------- standings ---------- */}
      <section className="fp-sect">
        <div className="fp-sect__h">
          <span className="fp-lbl">{t('faction.standings')}</span>
          <span className="fp-lbl fp-lbl--dim">{t('faction.tapRow')}</span>
        </div>
        <div role="table" aria-label={t('faction.standings.aria')}>
          <div role="rowgroup">
            <div className="fp-head" role="row">
              <span role="columnheader">{t('faction.col.metal')}</span>
              <span role="columnheader">{t('faction.col.credits')}</span>
              <span role="columnheader">{t('faction.col.science')}</span>
              <span role="columnheader">{t('faction.col.worlds')}</span>
              <span role="columnheader">{t('faction.col.systems')}</span>
              <span role="columnheader">{t('faction.col.fleet')}</span>
            </div>
          </div>
          {ranked.map(f => {
            const mine = f.id === me.id;
            const eliminated = f.status === 'eliminated';
            const dormant = !eliminated && (f.bodies_owned ?? 0) === 0
              && (f.ship_count ?? 0) === 0;
            const top = topPactKind(f.id);
            const factionPacts = pactsByFaction.get(f.id) ?? [];
            const open = openRows.has(f.id);
            // WAR only when one is open between us — declared, seeded or
            // pact-broken. A war outranks every pact (a construction pact
            // is no ceasefire); no war and no pact is NEUTRAL, not WAR.
            const atWar = !mine && wars.some(w => w.open
              && w.factions.includes(me.id) && w.factions.includes(f.id));
            const statusKey: keyof typeof STATUS_LABEL = mine ? 'self'
              : atWar ? 'war' : (top ?? 'neutral');
            return (
              <div
                key={f.id}
                role="rowgroup"
                className={'fp-row'
                  + (mine ? ' fp-row--you' : '')
                  + (eliminated ? ' fp-row--out' : '')
                  // Drives the hover wash, which is scoped to CLOSED rows:
                  // an open row contains the drawer, and highlighting the
                  // whole thing would wash controls that are not part of
                  // the toggle target.
                  + (open ? ' fp-row--open' : '')}
              >
                <button
                  type="button"
                  className="fp-row__id"
                  aria-expanded={open}
                  onClick={() => toggleRow(f.id)}
                >
                  <span className="fp-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  {/* Presence dot. Deliberately NOT shown on eliminated
                      factions — "OUT and green" is a contradiction, and
                      whether a knocked-out player still has the tab open
                      is not information anyone needs. The title carries
                      the meaning in words so it never depends on colour
                      alone, which also covers the red/green-blind case
                      that a two-state dot would otherwise fail. */}
                  <span
                    className={'fp-live'
                      + (onlineSet.has(f.user_id ?? '') ? ' is-online' : '')
                      // Hidden, not removed: dropping the node would pull
                      // an eliminated row's flag and name left by the
                      // dot's width and leave the roster ragged.
                      + (eliminated ? ' is-na' : '')}
                    title={eliminated ? undefined : (onlineSet.has(f.user_id ?? '')
                      ? (mine ? t('faction.online.you') : t('faction.online.them', { name: f.name }))
                      : (mine ? t('faction.offline.you') : t('faction.offline.them', { name: f.name })))}
                    aria-hidden={eliminated ? true : undefined}
                    aria-label={eliminated ? undefined
                      : (onlineSet.has(f.user_id ?? '') ? t('faction.online') : t('faction.offline'))}
                  />
                  <FlagChip className="mp-swatch" color={f.color} color2={f.color2}
                    emblem={f.emblem} fallbackKey={f.id} size={16} />
                  <span className="fp-name" title={f.name}>{f.name}</span>
                  {!!f.commissioned && (
                    <span className="fp-holder" title={t('faction.holderTitle', { name: t('hangar.commissionName') })} aria-label={t('faction.holderTitle', { name: t('hangar.commissionName') })}>{HOLDER_MARK}</span>
                  )}
                  <span
                    className="fp-state"
                    style={{ color: eliminated ? 'var(--mp-fg-dim)' : STATUS_COLOR[statusKey] }}
                  >
                    {eliminated ? t('faction.state.out') : dormant ? t('faction.state.dormant') : (mine ? t('faction.state.you') : statusText(statusKey))}
                  </span>
                  <span
                    className="fp-wt"
                    title={t('faction.weightTip')}
                  >
                    ★{weightOf(f)}
                  </span>
                </button>

                {/* The stats strip toggles the drawer too, so the whole
                    collapsed row is one target rather than just the name.
                    Deliberately NOT given role="button" or a tabIndex: the
                    .fp-row__id button above already carries this exact
                    action, and a second tab stop for the same toggle is a
                    worse keyboard experience, not a better one. This is a
                    mouse-target enlargement, and the button stays the
                    accessible control. */}
                <div
                  className="fp-stats"
                  role="row"
                  aria-label={f.name}
                  onClick={() => toggleRow(f.id)}
                >
                  {/* One gate for all three: null means no Economic Intel. */}
                  <span role="cell">{f.metal === null
                    ? <span className="fp-lock" title={t('faction.lock.econ')}>🔒</span>
                    : compact(f.metal)}</span>
                  <span role="cell">{f.gold === null ? '' : compact(f.gold)}</span>
                  <span role="cell">{f.science === null ? '' : compact(f.science)}</span>
                  <span role="cell">{f.bodies_owned ?? 0}</span>
                  <span role="cell">{f.systems_owned ?? 0}/{systemsTotal || '—'}</span>
                  <span role="cell">
                    {f.ship_count === null
                      ? <span className="fp-lock" title={t('faction.lock.census')}>🔒</span>
                      : (f.ship_count ?? 0)}
                  </span>
                </div>

                {open && (
                  <div className="fp-drawer">
                    <div className="fp-kv">
                      <span className="fp-k">{t('faction.income')}</span>
                      {f.income === null
                        ? <span className="fp-lock" title={t('faction.lock.econ')}>🔒 {t('faction.sensors', { n: 4 })}</span>
                        : <IncomeChips income={f.income ?? { metal: 0, fuel: 0, gold: 0, science: 0 }} />}
                    </div>
                    <div className="fp-kv">
                      <span className="fp-k">{t('faction.tech')}</span>
                      {f.tech_levels
                        ? <TechPips levels={f.tech_levels} />
                        : <span className="fp-lock" title={t('faction.lock.research')}>🔒 {t('faction.sensors', { n: 6 })}</span>}
                    </div>
                    <div className="fp-kv">
                      <span className="fp-k">{t('faction.status')}</span>
                      <span>
                        {eliminated ? t('faction.status.eliminated')
                          : dormant ? t('faction.status.dormant')
                          : mine ? t('faction.status.active')
                          : t('faction.status.activeRel', { relation: RELATION_TEXT[statusKey] ? t(RELATION_TEXT[statusKey] as Key) : '' })}
                      </span>
                    </div>
                    {!mine && !eliminated && (() => {
                      const war = wars.find(w => w.open
                        && w.factions.includes(me.id) && w.factions.includes(f.id));
                      const api = warsApi(gameId);
                      if (war) {
                        const theyOffered = !!war.ceasefire_by && war.ceasefire_by !== me.id;
                        const iOffered = war.ceasefire_by === me.id;
                        return (
                          <div className="fp-pact">
                            <span>{theyOffered ? t('faction.war.theyOffer', { name: f.name })
                              : iOffered ? t('faction.war.iOffered')
                              : t('faction.war.atWar')}</span>
                            <button
                              disabled={warBusy === f.id}
                              onClick={() => runWar(f.id,
                                () => (iOffered ? api.endUndo(f.id) : api.end(f.id)),
                                'faction.err.ceasefire')}
                              title={theyOffered ? t('faction.war.acceptTip')
                                : iOffered ? t('faction.war.withdrawTip')
                                : t('faction.war.offerTip')}
                            >
                              {theyOffered ? t('faction.war.accept') : iOffered ? t('faction.war.withdraw') : t('faction.war.offer')}
                            </button>
                          </div>
                        );
                      }
                      const allied = factionPacts.length > 0;
                      return warConfirm === f.id ? (
                        <div className="fp-pact">
                          <span>{allied
                            ? t('faction.war.breaksPact', { name: f.name })
                            : t('faction.war.immediate')}</span>
                          <span style={{ display: 'flex', gap: 6 }}>
                            <button
                              disabled={warBusy === f.id}
                              onClick={() => runWar(f.id, () => api.declare(f.id), 'faction.err.declare')}
                            >{t('faction.war.confirm')}</button>
                            <button onClick={() => setWarConfirm(null)}>{t('faction.war.cancel')}</button>
                          </span>
                        </div>
                      ) : (
                        <div className="fp-pact">
                          <span>{t('faction.war.atPeace')}</span>
                          <button
                            onClick={() => setWarConfirm(f.id)}
                            title={allied
                              ? t('faction.war.declareTipBreaks')
                              : t('faction.war.declareTip')}
                          >{t('faction.war.declare')}</button>
                        </div>
                      );
                    })()}
                    {factionPacts.map(pct => (
                      <div key={pct.id} className="fp-pact">
                        <span>{t('faction.pact.signed', { kind: tk(`faction.pact.${pct.kind}`, PACT_LABELS[pct.kind]), tick: pct.signed_at_tick })}</span>
                        <button
                          onClick={() => handleBreak(pct.id)}
                          disabled={breaking === pct.id}
                          title={t('faction.break.tip')}
                        >
                          {breaking === pct.id ? t('faction.breaking') : t('faction.break')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="fp-foot">
          {t('faction.foot')}
        </div>
      </section>

      {/* ---------- paths to victory ---------- */}
      <section className="fp-sect">
        <div className="fp-sect__h"><span className="fp-lbl">{t('faction.paths')}</span></div>

        {chamber > 0 && senLeader && (
          <VictoryTrack
            label={t('faction.vt.senate')}
            who={senLeader.name}
            color={senLeader.color}
            value={weightOf(senLeader)}
            target={chamber}
            readout={t('faction.vt.senate.readout', { w: weightOf(senLeader), total: chamber })}
            note={t('faction.vt.senate.note')}
          />
        )}

        {dyson && dysonOwner && (
          <VictoryTrack
            label={t('faction.vt.dyson')}
            who={dysonOwner.name}
            color={dysonOwner.color}
            value={dyson.hp}
            target={dyson.max_hp}
            readout={`${compact(dyson.hp)} / ${compact(dyson.max_hp)}`}
            note={t('faction.vt.dyson.note')}
          />
        )}

        {bodiesTotal > 0 && domLeader && (
          <VictoryTrack
            label={t('faction.vt.domination', { n: dominationTarget })}
            who={domLeader.name}
            color={domLeader.color}
            value={domLeader.bodies_owned ?? 0}
            target={dominationTarget}
            readout={`${domLeader.bodies_owned ?? 0} / ${dominationTarget}`}
            youAt={bodiesTotal > 0
              ? (myScore.bodies_owned ?? 0) / dominationTarget
              : undefined}
            note={t('faction.vt.domination.note', { n: myScore.bodies_owned ?? 0 })}
          />
        )}
      </section>

      {breakError && (
        <div className="mp-empty" style={{ color: 'var(--mp-hostile)', marginTop: 6 }}>
          {breakError}
        </div>
      )}
    </div>
  );
}

/** Dyson progress as sent by GET /factions. */
interface DysonProgress { controller: string | null; hp: number; max_hp: number }

/** Live senate weight. `senate_weight` on the row is VESTIGIAL — the
 *  senate recomputes at cast time and never writes it back, so it sits at
 *  1 forever. Prefer the computed value. */
function weightOf(f: Faction): number {
  return f.vote_weight ?? f.senate_weight ?? 1;
}

/** 32790 -> "32.8k". Keeps six columns inside a 376px panel without
 *  truncating the number that matters. */
function compact(n: number | null | undefined): string {
  const v = Math.round(Number(n ?? 0));
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** Black or white, whichever reads on this faction's colour. Faction
 *  colours span white (#f5f5f5) to deep purple, so a fixed label colour
 *  is unreadable on one end or the other. */
function readableOn(hex: string): string {
  const h = (hex || '#888').replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = n.map(v => (Number.isFinite(v) ? v : 136));
  // Rec. 601 luma is good enough for a two-way pick.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0a0f16' : '#ffffff';
}

const INCOME_TINT_KEYS: Array<[keyof FactionIncome, string, string]> = [
  ['metal', 'M', 'var(--res-metal)'],
  ['gold', 'C', 'var(--res-credit)'],
  ['science', 'S', 'var(--res-science)'],
];
type FactionIncome = NonNullable<Faction['income']>;

function IncomeChips({ income }: { income: FactionIncome }) {
  useI18n();
  const chips = INCOME_TINT_KEYS
    // Whole numbers. "+27.4M" under a "9.2k" stockpile column reads as
    // 27.4 MILLION — the decimal makes the M parse as magnitude instead
    // of metal. Rounded, coloured, and "/tick" spelled out, it parses as
    // a rate line the way the mockup's did.
    .map(([k, suffix, tint]) => ({ v: Math.round(income[k] ?? 0), suffix, tint }))
    .filter(c => c.v > 0);
  if (chips.length === 0) return <span className="fp-dim">{t('faction.noIncome')}</span>;
  return (
    <span className="fp-income">
      {chips.map(c => (
        <span key={c.suffix} style={{ color: c.tint }}>+{c.v}{c.suffix}</span>
      ))}
      <span className="fp-dim">{t('faction.perTick')}</span>
    </span>
  );
}

/** Six tracks as bars rather than "W10 A10 P10 C10 I10 S10" — the shape
 *  reads at a glance and the exact levels stay in the tooltip. */
function TechPips({ levels }: { levels: Record<string, number> }) {
  const tracks: Array<[string, string]> = [
    ['weapons', 'W'], ['armor', 'A'], ['propulsion', 'P'],
    ['construction', 'C'], ['industry', 'I'], ['sensors', 'S'],
  ];
  const readout = tracks.map(([k, a]) => `${a}${levels[k] ?? 0}`).join(' ');
  return (
    <span className="fp-pips-wrap">
      <span className="fp-pips" aria-hidden="true">
        {tracks.map(([k]) => (
          <i key={k} style={{ height: `${2 + 1.2 * Math.min(10, levels[k] ?? 0)}px` }} />
        ))}
      </span>
      {/* The letters are the data; the pips are the shape. The mockup
          showed both, and a tooltip is not a place to keep data. */}
      <span className="fp-pips__txt">{readout}</span>
    </span>
  );
}

/**
 * One victory path. The readout carries its own background because the
 * fill grows from the left — without it the number becomes unreadable
 * exactly as a faction approaches the threshold, which is when it matters.
 */
function VictoryTrack({
  label, who, color, value, target, readout, note, youAt,
}: {
  label: string; who: string; color: string;
  value: number; target: number; readout: string; note: string;
  /** Your own progress as a 0-1 fraction of the target, if worth marking. */
  youAt?: number;
}) {
  const pct = target > 0 ? Math.min(100, (100 * value) / target) : 0;
  return (
    <div className="fp-vt">
      <div className="fp-vt__h">
        <span className="fp-vt__t">{label}</span>
        <span className="fp-vt__who" title={who}>{who}</span>
      </div>
      <div className="fp-vt__rail">
        <div className="fp-vt__seg" style={{ width: `${pct}%`, background: color }} />
        {youAt !== undefined && youAt > 0 && youAt < 1 && (
          <div className="fp-vt__you" style={{ left: `${100 * youAt}%` }} />
        )}
        <span className="fp-vt__pct">{readout}</span>
      </div>
      <div className="fp-vt__n">{note}</div>
    </div>
  );
}
