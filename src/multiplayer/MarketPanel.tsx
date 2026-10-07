// ============================================================
// MarketPanel — the open market board (Trade dock › MARKET).
//
// A post is an offer with no named responder: everyone in the game sees
// it, enemies included, and anyone but the poster can take it — all of
// it, or part of it when the poster sells in parts. Taking strikes an
// ordinary private deal on the server, so what happens next (freighters,
// standing routes) lives under PRIVATE and ROUTES — this tab is the
// board, the going rate, and the tape.
//
// Built for a narrow dock: two short lines per post (GIVES / WANTS)
// rather than one long one, because a two-resource bundle would wrap a
// single line into nonsense.
//
// Mounts outside any assumption about GameContext, like TradesPanel:
// everything it shows is fetched.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiFetch, marketApi, MarketPost, MarketView, ResourceBundle, MyFaction, Faction, AssetListing,
} from './api';
import { logUiEvent } from './telemetry';
import {
  TradeComposer, resWord, resTitle, bundleWordsT, marketRateT, goingRateTextT, fmtTicksAsTimeT,
} from './TradeComposer';
import { t, tn, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';
import { hasFeature, requirementFor } from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';
import {
  MARKET_KEYS as KEYS, MarketKey, nonZeroKeys as nonZero,
  compareToGoingRate, costForUnits,
  afterTariff, unitCostForTaker,
} from './marketMath';
import { markMarketSeen } from './marketSeen';
import './MarketPanel.css';

const COLOR: Record<keyof ResourceBundle, string> = { metal: '#a0a0a0', gold: '#ffd700', science: '#6ee7b7' };

const fmt = (n: number) => Math.round(n).toLocaleString();

function Bundle({ b }: { b: ResourceBundle }) {
  useI18n();
  const keys = nonZero(b);
  if (keys.length === 0) return <span className="mkt-dim">{t('market.nothing')}</span>;
  return (
    <>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 && <span className="mkt-dim"> + </span>}
          <b style={{ color: COLOR[k] }}>{fmt(b[k])}</b> {resWord(k)}
        </span>
      ))}
    </>
  );
}

type Freighter = { id: string; name: string; where: string };

export function MarketPanel({ gameId }: { gameId: string }) {
  useI18n();
  useEffect(() => { logUiEvent(gameId, 'market'); }, [gameId]);
  const api = useMemo(() => marketApi(gameId), [gameId]);
  const [view, setView] = useState<MarketView | null>(null);
  // Hulls and worlds for sale to whoever claims them first. A different
  // lifecycle from goods (the buyer hauls the payment to the asset), so a
  // different list — but the same board, because it is the same question:
  // what is on offer to anyone?
  const [listings, setListings] = useState<AssetListing[]>([]);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [factions, setFactions] = useState<Faction[]>([]);
  // BROWSE BY NEED. Two questions a trader actually asks: "who is
  // selling what I am short of" and "who wants what I have too much of".
  const [need, setNeed] = useState<MarketKey | null>(null);
  const [have, setHave] = useState<MarketKey | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tapeOpen, setTapeOpen] = useState(false);
  const [composer, setComposer] = useState<
    | { kind: 'post' }
    | { kind: 'counter'; post: MarketPost }
    | null
  >(null);

  const refresh = useCallback(async () => {
    const [res, ls] = await Promise.all([api.list(), api.assetListings()]);
    if (ls.ok) setListings(ls.data.listings ?? []);
    if (!res.ok) return;
    setView(res.data);
    // You are looking at the board: everything on it is now seen, and
    // the rail badge that brought you here can stand down.
    markMarketSeen(gameId, res.data.posts);
  }, [api, gameId]);

  const loadMe = useCallback(async () => {
    const [meRes, fRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (fRes.ok) setFactions(fRes.data.factions);
  }, [gameId]);

  useEffect(() => {
    refresh();
    loadMe();
    // The room pushes a 'market' event on every post, take and
    // withdrawal (re-dispatched by MultiplayerShell), so the poll is only
    // the fallback for a dropped socket — it can be slow.
    const t = setInterval(refresh, 20000);
    const m = setInterval(loadMe, 60000);
    const onWs = (e: Event) => {
      const kind = (e as CustomEvent).detail?.kind;
      if (kind === 'market') refresh();
    };
    window.addEventListener('orbital:ws', onWs as EventListener);
    return () => {
      clearInterval(t); clearInterval(m);
      window.removeEventListener('orbital:ws', onWs as EventListener);
    };
  }, [refresh, loadMe]);

  // Same gate the private composer uses: goods ride freighters, so a
  // faction that cannot build one can neither ship a post nor pay for
  // one. Pure predicate — this panel has no GameContext to ask.
  const tradeLock = useMemo(() => {
    if (!me) return null;
    const enabled = (me.gating_enabled ?? 0) === 1;
    if (hasFeature('hull.freighter', me.tech_levels, enabled)) return null;
    const req = requirementFor('hull.freighter');
    if (!req) return null;
    const track = TECH_DEFS[req.track]?.name ?? req.track;
    return { where: `${track} ${req.level}` };
  }, [me]);
  // Built at render, not inside the memo, so it follows the language.
  const lockText = tradeLock ? t('trade.unlocksAt', { where: tradeLock.where }) : null;

  const posts = useMemo(() => view?.posts ?? [], [view]);
  const rates = useMemo(() => view?.rates ?? [], [view]);
  const interval = view?.tick_interval_ms ?? 3600000;
  const shown = useMemo(() => {
    const out = posts.filter(p => {
      if (mineOnly && !p.mine) return false;
      if (need && !((p.offer[need] ?? 0) > 0)) return false;
      if (have && !((p.request[have] ?? 0) > 0)) return false;
      return true;
    });
    // Asking for something specific? Cheapest first. Otherwise newest.
    if (need) {
      out.sort((a, b) => unitCostForTaker(a, need) - unitCostForTaker(b, need));
    }
    return out;
  }, [posts, need, have, mineOnly]);
  const myOpen = posts.filter(p => p.mine).length;
  const atCap = view != null && myOpen >= view.max_open;
  const lapsed = view?.mine_expired ?? [];

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } | null }>, fallback: Key) => {
    setBusyId(id);
    setError(null);
    const res = await fn();
    setBusyId(null);
    if (!res.ok) setError(apiErrorText(res.error, fallback));
    await refresh();
    return res.ok;
  };

  const goTab = (tab: 'market' | 'private') => {
    try { window.dispatchEvent(new CustomEvent('tradedock:tab', { detail: { tab } })); } catch {}
  };

  const filtering = need != null || have != null || mineOnly;

  return (
    <div className="mkt">
      <div className="mkt-head">
        <div>
          <div className="mkt-title">{t('market.title')}</div>
          <div className="mkt-sub">
            {view == null ? t('trade.loading')
              : tn('market.postsLine', posts.length, { mine: myOpen, max: view.max_open })}
          </div>
        </div>
        <button
          className="mp-btn mp-btn--primary"
          disabled={!!tradeLock || atCap || !me}
          title={lockText ?? (atCap ? t('market.freeSlot') : t('market.offerTip'))}
          onClick={() => { setError(null); setNotice(null); setComposer({ kind: 'post' }); }}
        >
          {tradeLock ? t('market.locked') : `+ ${t('market.post')}`}
        </button>
      </div>

      <div className="mkt-hint">
        {t('market.hint')}
      </div>
      {lockText && (
        <div className="mkt-lock">
          {t('market.lockNote', { unlock: lockText.charAt(0).toLowerCase() + lockText.slice(1) })}
        </div>
      )}

      {rates.length > 0 && (
        <div className="mkt-rates" title={t('market.ratesTip')}>
          <span className="mkt-k">{t('market.recent')}</span>
          <span>{rates.map(goingRateTextT).join(' · ')}</span>
        </div>
      )}

      <div className="mkt-browse">
        <div className="mkt-chiprow" role="group" aria-label={t('market.showGiving')}>
          <span className="mkt-k">{t('market.iNeed')}</span>
          {KEYS.map(k => (
            <button
              key={k}
              aria-pressed={need === k}
              className={`mkt-chip${need === k ? ' is-on' : ''}`}
              title={t('market.givingTip', { res: resWord(k) })}
              onClick={() => setNeed(need === k ? null : k)}
            >{resTitle(k)}</button>
          ))}
        </div>
        <div className="mkt-chiprow" role="group" aria-label={t('market.showWanting')}>
          <span className="mkt-k">{t('market.iHave')}</span>
          {KEYS.map(k => (
            <button
              key={k}
              aria-pressed={have === k}
              className={`mkt-chip${have === k ? ' is-on' : ''}`}
              title={t('market.wantingTip', { res: resWord(k) })}
              onClick={() => setHave(have === k ? null : k)}
            >{resTitle(k)}</button>
          ))}
          <button
            aria-pressed={mineOnly}
            className={`mkt-chip mkt-chip--mine${mineOnly ? ' is-on' : ''}`}
            title={t('market.mineTip')}
            onClick={() => setMineOnly(v => !v)}
          >{t('market.mine')}</button>
        </div>
      </div>

      {error && <div className="mp-error" style={{ marginBottom: 8 }}>{error}</div>}
      {notice && (
        <div className="mkt-notice">
          {notice}{' '}
          <button className="mkt-link" onClick={() => goTab('private')}>{t('market.openPrivate')}</button>
        </div>
      )}

      {lapsed.length > 0 && (
        <div className="mkt-lapsed">
          <div className="mkt-lapsed__head">
            {tn('market.lapsed', lapsed.length)}
          </div>
          {lapsed.map(p => (
            <div key={p.id} className="mkt-lapsed__row">
              <span className="mkt-lapsed__terms">
                {bundleWordsT(p.offer)} <span className="mkt-dim">{t('market.for')}</span> {bundleWordsT(p.request)}
              </span>
              <span className="mkt-actions mkt-actions--tight">
                <button
                  className="mp-btn mp-btn--primary"
                  disabled={busyId === p.id || atCap}
                  title={atCap ? t('market.freeSlot') : t('market.putBack', { time: fmtTicksAsTimeT(p.ttl_ticks, interval) })}
                  onClick={() => run(p.id, () => api.renew(p.id), 'market.err.renew')}
                >{t('market.renew')}</button>
                <button
                  className="mp-btn"
                  disabled={busyId === p.id}
                  title={t('market.clearTip')}
                  onClick={() => run(p.id, () => api.withdraw(p.id), 'market.err.clear')}
                >{t('market.clear')}</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {view != null && shown.length === 0 && !(listings.length > 0 && !filtering) && (
        <div className="mkt-empty">
          {mineOnly
            ? t('market.emptyMine')
            : !filtering
              ? t('market.emptyBoard')
              : need && have
                ? t('market.emptyBoth', { need: resWord(need), have: resWord(have) })
                : need
                  ? t('market.emptyNeed', { res: resWord(need) })
                  : t('market.emptyHave', { res: resWord(have as MarketKey) })}
        </div>
      )}

      {shown.map(post => {
        const left = view ? Math.max(0, post.expires_at_tick - view.tick) : 0;
        const rate = marketRateT(post);
        const cmp = post.mine ? null : compareToGoingRate(post, rates);
        const confirming = confirmId === post.id;
        const busy = busyId === post.id;
        const rec = post.poster_record;
        return (
          <div key={post.id} className={`mkt-row${post.mine ? ' is-mine' : ''}`}>
            <div className="mkt-row__top">
              <span className="mkt-who">
                <span className="mkt-dot" style={{ background: post.poster_color ?? '#a8b8c8' }} />
                <span className="mkt-who__name">{post.mine ? t('market.you') : (post.poster_name ?? t('market.unknown'))}</span>
                {!post.mine && (rec.delivered > 0 || rec.stalled > 0) && (
                  <span
                    className="mkt-rec"
                    title={t('market.recTip')}
                  >
                    {t('market.delivered', { n: rec.delivered })}
                    {rec.stalled > 0 && <span className="mkt-warn"> · {t('market.stalled', { n: rec.stalled })}</span>}
                  </span>
                )}
              </span>
              <span className="mkt-meta" title={t('market.listedUntil', { n: post.expires_at_tick })}>
                {t('market.left', { time: fmtTicksAsTimeT(left, interval) })}
              </span>
            </div>
            <div className="mkt-tags">
              {post.recurring && (
                <span className="mkt-tag" title={t('market.perRunTip')}>{t('market.perRun')}</span>
              )}
              {post.divisible && (
                <span className="mkt-tag mkt-tag--amber" title={t('market.partsTip')}>
                  {post.units_left < post.units_total
                    ? t('market.unitsLeft', { left: fmt(post.units_left), total: fmt(post.units_total) })
                    : t('market.soldInParts')}
                </span>
              )}
              {post.has_ship && (
                <span
                  className="mkt-tag"
                  title={post.recurring
                    ? t('market.hullTipRoute')
                    : t('market.hullTip')}
                >{t('market.hullReady')}</span>
              )}
            </div>
            <div className="mkt-terms">
              <span className="mkt-k">{t('market.gives')}</span><span><Bundle b={post.offer} /></span>
              <span className="mkt-k">{t('market.wants')}</span>
              <span>
                <Bundle b={post.request} />
                {rate && <span className="mkt-rate">{rate}</span>}
              </span>
            </div>
            {cmp && (
              <div className={`mkt-cmp${cmp.better ? ' is-good' : ' is-bad'}`}>
                {t(cmp.better ? 'market.cmpBetter' : 'market.cmpWorse', { pct: cmp.pct })}
              </div>
            )}
            {post.note && <div className="mkt-note">“{post.note}”</div>}

            {confirming && view && me ? (
              <TakeConfirm
                gameId={gameId}
                post={post}
                me={me}
                tariffPct={view.my_tariff_pct}
                onCancel={() => setConfirmId(null)}
                onStruck={(msg) => {
                  setConfirmId(null);
                  setNotice(msg);
                  refresh(); loadMe();
                }}
                onFailed={(msg) => { setConfirmId(null); setError(msg); refresh(); }}
              />
            ) : post.mine ? (
              <div className="mkt-actions">
                <button
                  className="mp-btn"
                  disabled={busy}
                  onClick={() => run(post.id, () => api.withdraw(post.id), 'market.err.withdraw')}
                >{busy ? t('market.withdrawing') : t('market.withdraw')}</button>
                <button
                  className="mp-btn"
                  disabled={busy}
                  title={t('market.resetClock', { time: fmtTicksAsTimeT(post.ttl_ticks, interval) })}
                  onClick={() => run(post.id, () => api.renew(post.id), 'market.err.renew')}
                >{t('market.renew')}</button>
              </div>
            ) : (
              <div className="mkt-actions">
                <button
                  className="mp-btn mp-btn--primary"
                  disabled={!!tradeLock || busy || !me}
                  title={lockText ?? (post.divisible ? t('market.takeTipParts') : t('market.takeTip'))}
                  onClick={() => { setError(null); setNotice(null); setConfirmId(post.id); }}
                >{post.divisible ? t('market.takeEllipsis') : t('market.take')}</button>
                <button
                  className="mp-btn"
                  disabled={!!tradeLock || !me}
                  title={lockText ?? t('market.counterTip')}
                  onClick={() => { setError(null); setNotice(null); setComposer({ kind: 'counter', post }); }}
                >{t('market.counter')}</button>
              </div>
            )}
          </div>
        );
      })}

      {listings.length > 0 && !need && !have && (
        <div className="mkt-assets">
          <div className="mkt-assets__head">
            <span>{t('market.assets')}</span>
            <span className="mkt-dim">{listings.filter(l => !mineOnly || l.mine).length}</span>
          </div>
          {listings.filter(l => !mineOnly || l.mine).map(l => {
            const price: ResourceBundle = { metal: l.price_metal, gold: l.price_credits, science: 0 };
            const busy = busyId === l.id;
            const shortOf = me ? KEYS.filter(k => price[k] > Number(me[k] ?? 0)) : [];
            return (
              <div key={l.id} className={`mkt-row${l.mine ? ' is-mine' : ''}`}>
                <div className="mkt-row__top">
                  <span className="mkt-who">
                    <span className="mkt-dot" style={{ background: l.seller_color ?? '#a8b8c8' }} />
                    <span className="mkt-who__name">{l.mine ? t('market.you') : l.seller_name}</span>
                  </span>
                  <span className="mkt-meta">{l.asset_kind === 'ship' ? t('market.kindHull') : t('market.kindWorld')}</span>
                </div>
                <div className="mkt-terms">
                  <span className="mkt-k">{t('market.sells')}</span>
                  <span><b>{l.asset_name}</b>{l.asset_detail && <span className="mkt-dim"> · {l.asset_detail}</span>}</span>
                  <span className="mkt-k">{t('market.price')}</span><span><Bundle b={price} /></span>
                  {l.delivery_body_name && (
                    <><span className="mkt-k">{t('market.at')}</span><span>{l.delivery_body_name}</span></>
                  )}
                </div>
                {claimId === l.id ? (
                  <div className="mkt-confirm">
                    <div>
                      {t('market.claim.owe')} <b>{bundleWordsT(price)}</b>{t('market.claim.hauled')} <b>{l.delivery_body_name ?? t('market.claim.whereStands')}</b>{t('market.claim.rest')}
                      {shortOf.length > 0 && (
                        <span className="mkt-warn">
                          {' '}{t('market.claim.short', { list: shortOf.map(k => resWord(k)).join(` ${t('market.and')} `) })}
                        </span>
                      )}
                    </div>
                    <div className="mkt-actions">
                      <button
                        className="mp-btn mp-btn--primary"
                        disabled={busy}
                        onClick={async () => {
                          const ok = await run(l.id, () => api.claimAsset(l.id), 'market.err.claim');
                          setClaimId(null);
                          if (ok) setNotice(t('market.claim.done', { name: l.asset_name }));
                        }}
                      >{busy ? t('market.claiming') : t('market.confirm')}</button>
                      <button className="mp-btn" disabled={busy} onClick={() => setClaimId(null)}>{t('market.back')}</button>
                    </div>
                  </div>
                ) : l.mine ? (
                  <div className="mkt-actions">
                    <button
                      className="mp-btn"
                      disabled={busy}
                      onClick={() => run(l.id, () => api.withdrawAsset(l.id), 'market.err.withdrawListing')}
                    >{busy ? t('market.withdrawing') : t('market.withdraw')}</button>
                  </div>
                ) : (
                  <div className="mkt-actions">
                    <button
                      className="mp-btn mp-btn--primary"
                      disabled={!!tradeLock || busy || !me}
                      title={lockText ?? t('market.buyTip')}
                      onClick={() => { setError(null); setNotice(null); setClaimId(l.id); }}
                    >{t('market.buy')}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view != null && view.recent.length > 0 && (
        <div className="mkt-tape">
          <button className="mkt-tape__head" onClick={() => setTapeOpen(o => !o)} aria-expanded={tapeOpen}>
            <span>{tapeOpen ? '▾' : '▸'} {t('market.recent')}</span>
            <span className="mkt-dim">{view.recent.length}</span>
          </button>
          {tapeOpen && view.recent.map(f => (
            <div key={f.id} className="mkt-tape__row">
              <span style={{ color: f.taker_color ?? undefined }}>{f.taker_name ?? t('market.someoneCap')}</span>
              {` ${t('market.took')} `}
              <span style={{ color: f.poster_color ?? undefined }}>{f.poster_name ?? t('market.someone')}</span>
              {`${t('market.posters')} `}{bundleWordsT(f.offer)} {t('market.for')} {bundleWordsT(f.request)}
              {f.recurring ? ` ${t('market.perRun')}` : ''}
              <span className="mkt-dim"> · T+{f.at_tick}</span>
            </div>
          ))}
        </div>
      )}

      {composer && me && (
        <TradeComposer
          gameId={gameId}
          me={me}
          factions={factions}
          mode={composer.kind === 'post'
            ? { kind: 'new', market: true }
            : {
              kind: 'new',
              prefill: {
                responderId: composer.post.poster_faction_id,
                // Roles flip: what the post WANTS is what I would give.
                offer: { ...composer.post.request },
                request: { ...composer.post.offer },
                recurring: composer.post.recurring,
                marketPostId: composer.post.id,
              },
            }}
          onClose={() => setComposer(null)}
          onSuccess={() => {
            const wasCounter = composer.kind === 'counter';
            setComposer(null);
            refresh();
            if (wasCounter) {
              setNotice(t('market.counterSent'));
            }
          }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// The take, in the taker's words: how much, what it costs, what
// actually lands after the Senate's cut, and which freighter carries
// your half. Naming the hull HERE is the point — a one-time deal used
// to strike and then sit until both players remembered to go to PRIVATE
// and assign one.
// ----------------------------------------------------------------
function TakeConfirm({
  gameId, post, me, tariffPct, onCancel, onStruck, onFailed,
}: {
  gameId: string;
  post: MarketPost;
  me: MyFaction;
  tariffPct: number;
  onCancel: () => void;
  onStruck: (notice: string) => void;
  onFailed: (message: string) => void;
}) {
  useI18n();
  const api = useMemo(() => marketApi(gameId), [gameId]);
  const oK = nonZero(post.offer)[0];
  const rK = nonZero(post.request)[0];
  const [units, setUnits] = useState<number>(post.units_left);
  const [shipId, setShipId] = useState('');
  const [freighters, setFreighters] = useState<Freighter[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (post.recurring) return; // a standing deal flies a lane, not a shipment
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ freighters: Freighter[] }>(`/api/games/${gameId}/free-freighters`);
      if (cancelled) return;
      const list = res.ok ? (res.data?.freighters ?? []) : [];
      setFreighters(list);
      if (list.length > 0) setShipId(list[0].id);
    })();
    return () => { cancelled = true; };
  }, [gameId, post.recurring]);

  const q = post.divisible ? Math.max(1, Math.min(post.units_left, Math.floor(units) || 1)) : post.units_left;
  const give: ResourceBundle = post.divisible
    ? { metal: 0, gold: 0, science: 0, [rK]: costForUnits(post.offer[oK], post.request[rK], q) }
    : post.request;
  const get: ResourceBundle = post.divisible
    ? { metal: 0, gold: 0, science: 0, [oK]: q }
    : post.offer;
  const landed: ResourceBundle = {
    metal: afterTariff(get.metal, tariffPct),
    gold: afterTariff(get.gold, tariffPct),
    science: afterTariff(get.science, tariffPct),
  };
  const short = KEYS.filter(k => give[k] > Number(me[k] ?? 0));

  const strike = async () => {
    setBusy(true);
    const res = await api.take(post.id, {
      units: post.divisible ? q : undefined,
      ship_id: !post.recurring && shipId ? shipId : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      onFailed(apiErrorText(res.error, 'market.err.strike'));
      return;
    }
    const who = post.poster_name ?? t('market.thePoster');
    const mine = res.data.assigned?.mine;
    onStruck(post.recurring
      ? t('market.struck.route', { who })
      : mine?.ok
        ? t('market.struck.loading', { who })
        : mine && !mine.ok
          ? t('market.struck.but', { who, why: mine.message ?? '' })
          : t('market.struck.assign', { who }));
  };

  return (
    <div className="mkt-confirm">
      {post.divisible && (
        <div className="mkt-amount">
          <label className="mkt-k" htmlFor={`mkt-units-${post.id}`}>{t('market.take.howMuch', { res: resWord(oK) })}</label>
          <div className="mkt-amount__row">
            <input
              id={`mkt-units-${post.id}`}
              className="mkt-input"
              type="number" min={1} max={post.units_left} step={1}
              value={units}
              onChange={(e) => setUnits(Number(e.target.value))}
            />
            {[0.25, 0.5, 1].map(f => (
              <button
                key={f}
                type="button"
                className="mkt-chip"
                onClick={() => setUnits(Math.max(1, Math.floor(post.units_left * f)))}
              >{f === 1 ? t('market.take.all') : `${f * 100}%`}</button>
            ))}
          </div>
        </div>
      )}
      <div>
        {t('market.take.give')} <b>{bundleWordsT(give)}</b>{post.recurring ? ` ${t('market.take.everyRun')}` : ''} {t('market.take.andGet')} <b>{bundleWordsT(get)}</b>.
        {tariffPct > 0 && (
          <span className="mkt-warn">
            {' '}{t('market.take.tariff', { pct: tariffPct })}
            {' '}<b>{bundleWordsT(landed)}</b> {t('market.take.lands')}
          </span>
        )}
        {short.length > 0 && (
          <span className="mkt-warn">
            {' '}{t('market.take.short', { list: short.map(k => resWord(k)).join(` ${t('market.and')} `) })}
          </span>
        )}
      </div>
      {!post.recurring && (
        <div className="mkt-ship">
          <label className="mkt-k" htmlFor={`mkt-ship-${post.id}`}>{t('market.take.yourFreighter')}</label>
          {freighters == null ? (
            <span className="mkt-dim">{t('market.take.looking')}</span>
          ) : freighters.length === 0 ? (
            <span className="mkt-dim">
              {t('market.take.noneFree')}
            </span>
          ) : (
            <select
              id={`mkt-ship-${post.id}`}
              className="mp-select"
              value={shipId}
              onChange={(e) => setShipId(e.target.value)}
            >
              {freighters.map(f => (
                <option key={f.id} value={f.id}>{f.name} — {f.where}</option>
              ))}
              <option value="">{t('market.take.decideLater')}</option>
            </select>
          )}
        </div>
      )}
      <div className="mkt-actions">
        <button className="mp-btn mp-btn--primary" disabled={busy} onClick={strike}>
          {busy ? t('market.take.striking') : t('market.confirm')}
        </button>
        <button className="mp-btn" disabled={busy} onClick={onCancel}>{t('market.back')}</button>
      </div>
    </div>
  );
}
