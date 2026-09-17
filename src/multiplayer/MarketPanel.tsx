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
  apiFetch, marketApi, MarketPost, MarketView, ResourceBundle, MyFaction, Faction,
} from './api';
import { logUiEvent } from './telemetry';
import { TradeComposer } from './TradeComposer';
import { hasFeature, requirementFor } from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';
import {
  MARKET_KEYS as KEYS, MARKET_LABEL as LABEL, MarketKey, nonZeroKeys as nonZero,
  marketRate, bundleWords, goingRateText, compareToGoingRate, costForUnits,
  afterTariff, fmtTicksAsTime, unitCostForTaker,
} from './marketMath';
import { markMarketSeen } from './marketSeen';
import './MarketPanel.css';

const COLOR: Record<keyof ResourceBundle, string> = { metal: '#a0a0a0', gold: '#ffd700', science: '#6ee7b7' };
const CHIP_LABEL: Record<MarketKey, string> = { metal: 'Metal', gold: 'Credits', science: 'Science' };

const fmt = (n: number) => Math.round(n).toLocaleString();

function Bundle({ b }: { b: ResourceBundle }) {
  const keys = nonZero(b);
  if (keys.length === 0) return <span className="mkt-dim">nothing</span>;
  return (
    <>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 && <span className="mkt-dim"> + </span>}
          <b style={{ color: COLOR[k] }}>{fmt(b[k])}</b> {LABEL[k]}
        </span>
      ))}
    </>
  );
}

type Freighter = { id: string; name: string; where: string };

export function MarketPanel({ gameId }: { gameId: string }) {
  useEffect(() => { logUiEvent(gameId, 'market'); }, [gameId]);
  const api = useMemo(() => marketApi(gameId), [gameId]);
  const [view, setView] = useState<MarketView | null>(null);
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
    const res = await api.list();
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
    return `Unlocks at ${track} ${req.level}`;
  }, [me]);

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

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: { message?: string } | null }>, fallback: string) => {
    setBusyId(id);
    setError(null);
    const res = await fn();
    setBusyId(null);
    if (!res.ok) setError(res.error?.message ?? fallback);
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
          <div className="mkt-title">Open market</div>
          <div className="mkt-sub">
            {view == null ? 'Loading…'
              : `${posts.length} post${posts.length === 1 ? '' : 's'} · you have ${myOpen} of ${view.max_open}`}
          </div>
        </div>
        <button
          className="mp-btn mp-btn--primary"
          disabled={!!tradeLock || atCap || !me}
          title={tradeLock ?? (atCap ? 'Withdraw a post to free a slot' : 'Offer goods to anyone who will take them')}
          onClick={() => { setError(null); setNotice(null); setComposer({ kind: 'post' }); }}
        >
          {tradeLock ? 'Locked' : '+ Post'}
        </button>
      </div>

      <div className="mkt-hint">
        Everyone sees this board — rivals included. Taking a post strikes the
        deal; the goods still ship by freighter.
      </div>
      {tradeLock && (
        <div className="mkt-lock">
          Posting and taking {tradeLock.charAt(0).toLowerCase() + tradeLock.slice(1)}. Goods ride freighters,
          and you cannot build one yet. You can still read the board.
        </div>
      )}

      {rates.length > 0 && (
        <div className="mkt-rates" title="Low to high of the most recent deals struck on this board">
          <span className="mkt-k">Recent deals</span>
          <span>{rates.map(goingRateText).join(' · ')}</span>
        </div>
      )}

      <div className="mkt-browse">
        <div className="mkt-chiprow" role="group" aria-label="Show posts giving">
          <span className="mkt-k">I need</span>
          {KEYS.map(k => (
            <button
              key={k}
              aria-pressed={need === k}
              className={`mkt-chip${need === k ? ' is-on' : ''}`}
              title={`Posts that give ${LABEL[k]}, cheapest first`}
              onClick={() => setNeed(need === k ? null : k)}
            >{CHIP_LABEL[k]}</button>
          ))}
        </div>
        <div className="mkt-chiprow" role="group" aria-label="Show posts wanting">
          <span className="mkt-k">I have</span>
          {KEYS.map(k => (
            <button
              key={k}
              aria-pressed={have === k}
              className={`mkt-chip${have === k ? ' is-on' : ''}`}
              title={`Posts that want ${LABEL[k]}`}
              onClick={() => setHave(have === k ? null : k)}
            >{CHIP_LABEL[k]}</button>
          ))}
          <button
            aria-pressed={mineOnly}
            className={`mkt-chip mkt-chip--mine${mineOnly ? ' is-on' : ''}`}
            title="Only your own posts"
            onClick={() => setMineOnly(v => !v)}
          >Mine</button>
        </div>
      </div>

      {error && <div className="mp-error" style={{ marginBottom: 8 }}>{error}</div>}
      {notice && (
        <div className="mkt-notice">
          {notice}{' '}
          <button className="mkt-link" onClick={() => goTab('private')}>Open PRIVATE</button>
        </div>
      )}

      {lapsed.length > 0 && (
        <div className="mkt-lapsed">
          <div className="mkt-lapsed__head">
            {lapsed.length === 1 ? 'One of your posts expired' : `${lapsed.length} of your posts expired`}
          </div>
          {lapsed.map(p => (
            <div key={p.id} className="mkt-lapsed__row">
              <span className="mkt-lapsed__terms">
                {bundleWords(p.offer)} <span className="mkt-dim">for</span> {bundleWords(p.request)}
              </span>
              <span className="mkt-actions mkt-actions--tight">
                <button
                  className="mp-btn mp-btn--primary"
                  disabled={busyId === p.id || atCap}
                  title={atCap ? 'Withdraw a post to free a slot' : `Put it back up for ${fmtTicksAsTime(p.ttl_ticks, interval)}`}
                  onClick={() => run(p.id, () => api.renew(p.id), 'Could not renew that post.')}
                >Renew</button>
                <button
                  className="mp-btn"
                  disabled={busyId === p.id}
                  title="Take it down for good"
                  onClick={() => run(p.id, () => api.withdraw(p.id), 'Could not clear that post.')}
                >Clear</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {view != null && shown.length === 0 && (
        <div className="mkt-empty">
          {mineOnly
            ? 'You have nothing on the market.'
            : !filtering
              ? 'The board is empty. Post what you have spare and name your price.'
              : need && have
                ? `Nobody is offering ${LABEL[need]} for ${LABEL[have]} right now. Post the deal you want.`
                : need
                  ? `Nobody is offering ${LABEL[need]} right now.`
                  : `Nobody is asking for ${LABEL[have as MarketKey]} right now.`}
        </div>
      )}

      {shown.map(post => {
        const left = view ? Math.max(0, post.expires_at_tick - view.tick) : 0;
        const rate = marketRate(post);
        const cmp = post.mine ? null : compareToGoingRate(post, rates);
        const confirming = confirmId === post.id;
        const busy = busyId === post.id;
        const rec = post.poster_record;
        return (
          <div key={post.id} className={`mkt-row${post.mine ? ' is-mine' : ''}`}>
            <div className="mkt-row__top">
              <span className="mkt-who">
                <span className="mkt-dot" style={{ background: post.poster_color ?? '#a8b8c8' }} />
                <span className="mkt-who__name">{post.mine ? 'You' : (post.poster_name ?? 'Unknown')}</span>
                {!post.mine && (rec.delivered > 0 || rec.stalled > 0) && (
                  <span
                    className="mkt-rec"
                    title={'Their delivery record in this game: shipments landed, and shipments left '
                      + 'with no freighter for two days or more. Nothing escrows a post — this is how you judge a stranger.'}
                  >
                    {rec.delivered} delivered
                    {rec.stalled > 0 && <span className="mkt-warn"> · {rec.stalled} stalled</span>}
                  </span>
                )}
              </span>
              <span className="mkt-meta" title={`Listed until T+${post.expires_at_tick}`}>
                {fmtTicksAsTime(left, interval)} left
              </span>
            </div>
            <div className="mkt-tags">
              {post.recurring && (
                <span className="mkt-tag" title="Standing route: these are per-run amounts, shipped over and over until someone cancels.">per run</span>
              )}
              {post.divisible && (
                <span className="mkt-tag mkt-tag--amber" title="Sold in parts: take any amount, pay pro rata.">
                  {post.units_left < post.units_total
                    ? `${fmt(post.units_left)} of ${fmt(post.units_total)} left`
                    : 'sold in parts'}
                </span>
              )}
              {post.has_ship && (
                <span
                  className="mkt-tag"
                  title={post.recurring
                    ? 'The poster pinned a freighter — the lane starts flying the moment this is taken.'
                    : 'The poster pinned a freighter — their half ships as soon as this is taken.'}
                >hull ready</span>
              )}
            </div>
            <div className="mkt-terms">
              <span className="mkt-k">Gives</span><span><Bundle b={post.offer} /></span>
              <span className="mkt-k">Wants</span>
              <span>
                <Bundle b={post.request} />
                {rate && <span className="mkt-rate">{rate}</span>}
              </span>
            </div>
            {cmp && (
              <div className={`mkt-cmp${cmp.better ? ' is-good' : ' is-bad'}`}>
                {cmp.pct}% {cmp.better ? 'better' : 'worse'} for you than recent deals
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
                  onClick={() => run(post.id, () => api.withdraw(post.id), 'Could not withdraw that post.')}
                >{busy ? 'Withdrawing…' : 'Withdraw'}</button>
                <button
                  className="mp-btn"
                  disabled={busy}
                  title={`Reset the clock to ${fmtTicksAsTime(post.ttl_ticks, interval)}`}
                  onClick={() => run(post.id, () => api.renew(post.id), 'Could not renew that post.')}
                >Renew</button>
              </div>
            ) : (
              <div className="mkt-actions">
                <button
                  className="mp-btn mp-btn--primary"
                  disabled={!!tradeLock || busy || !me}
                  title={tradeLock ?? (post.divisible ? 'Buy all of it, or part' : 'Strike this deal as posted')}
                  onClick={() => { setError(null); setNotice(null); setConfirmId(post.id); }}
                >{post.divisible ? 'Take…' : 'Take'}</button>
                <button
                  className="mp-btn"
                  disabled={!!tradeLock || !me}
                  title={tradeLock ?? 'Send the poster different terms, privately. The post stays up.'}
                  onClick={() => { setError(null); setNotice(null); setComposer({ kind: 'counter', post }); }}
                >Counter</button>
              </div>
            )}
          </div>
        );
      })}

      {view != null && view.recent.length > 0 && (
        <div className="mkt-tape">
          <button className="mkt-tape__head" onClick={() => setTapeOpen(o => !o)} aria-expanded={tapeOpen}>
            <span>{tapeOpen ? '▾' : '▸'} Recent deals</span>
            <span className="mkt-dim">{view.recent.length}</span>
          </button>
          {tapeOpen && view.recent.map(f => (
            <div key={f.id} className="mkt-tape__row">
              <span style={{ color: f.taker_color ?? undefined }}>{f.taker_name ?? 'Someone'}</span>
              {' took '}
              <span style={{ color: f.poster_color ?? undefined }}>{f.poster_name ?? 'someone'}</span>
              {'’s '}{bundleWords(f.offer)} for {bundleWords(f.request)}
              {f.recurring ? ' per run' : ''}
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
              setNotice('Counter sent privately. The post stays on the board.');
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
      onFailed(res.error?.message ?? 'The deal could not be struck.');
      return;
    }
    const who = post.poster_name ?? 'the poster';
    const mine = res.data.assigned?.mine;
    onStruck(post.recurring
      ? `Deal struck with ${who} — the standing route is under PRIVATE.`
      : mine?.ok
        ? `Deal struck with ${who} — your freighter is on its way to load.`
        : mine && !mine.ok
          ? `Deal struck with ${who}, but ${mine.message}. Assign a freighter under PRIVATE.`
          : `Deal struck with ${who} — assign a freighter under PRIVATE to ship your side.`);
  };

  return (
    <div className="mkt-confirm">
      {post.divisible && (
        <div className="mkt-amount">
          <label className="mkt-k" htmlFor={`mkt-units-${post.id}`}>How much {LABEL[oK]}</label>
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
              >{f === 1 ? 'All' : `${f * 100}%`}</button>
            ))}
          </div>
        </div>
      )}
      <div>
        You give <b>{bundleWords(give)}</b>{post.recurring ? ' every run' : ''} and
        get <b>{bundleWords(get)}</b>.
        {tariffPct > 0 && (
          <span className="mkt-warn">
            {' '}The Senate’s {tariffPct}% tariff is skimmed off what you receive:
            {' '}<b>{bundleWords(landed)}</b> lands.
          </span>
        )}
        {short.length > 0 && (
          <span className="mkt-warn">
            {' '}You are short of {short.map(k => LABEL[k]).join(' and ')} — your side will
            wait at the dock until you can cover it.
          </span>
        )}
      </div>
      {!post.recurring && (
        <div className="mkt-ship">
          <label className="mkt-k" htmlFor={`mkt-ship-${post.id}`}>Your freighter</label>
          {freighters == null ? (
            <span className="mkt-dim">Looking for free freighters…</span>
          ) : freighters.length === 0 ? (
            <span className="mkt-dim">
              None free. The deal still strikes; assign one under PRIVATE when a hull frees up.
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
              <option value="">Decide later</option>
            </select>
          )}
        </div>
      )}
      <div className="mkt-actions">
        <button className="mp-btn mp-btn--primary" disabled={busy} onClick={strike}>
          {busy ? 'Striking…' : 'Confirm'}
        </button>
        <button className="mp-btn" disabled={busy} onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}
