// ============================================================
// MarketPanel — the open market board (Trade dock › MARKET).
//
// A post is an offer with no named responder: everyone in the game sees
// it, enemies included, and anyone but the poster can take it. Taking
// strikes an ordinary private deal on the server, so what happens next
// (freighters, standing routes) lives under PRIVATE and ROUTES — this
// tab is only the board and the tape.
//
// Built for the 360px dock: two short lines per post (GIVES / WANTS)
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
  MARKET_KEYS as KEYS, MARKET_LABEL as LABEL, nonZeroKeys as nonZero, marketRate, bundleWords,
} from './marketMath';
import './MarketPanel.css';

const COLOR: Record<keyof ResourceBundle, string> = { metal: '#a0a0a0', gold: '#ffd700', science: '#6ee7b7' };

type Filter = 'all' | 'metal' | 'gold' | 'science' | 'mine';
const FILTERS: Array<{ key: Filter; label: string; title: string }> = [
  { key: 'all', label: 'All', title: 'Every open post' },
  { key: 'metal', label: 'Metal', title: 'Posts giving metal' },
  { key: 'gold', label: 'Credits', title: 'Posts giving credits' },
  { key: 'science', label: 'Science', title: 'Posts giving science' },
  { key: 'mine', label: 'Mine', title: 'Your own posts' },
];

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

export function MarketPanel({ gameId }: { gameId: string }) {
  useEffect(() => { logUiEvent(gameId, 'market'); }, [gameId]);
  const api = useMemo(() => marketApi(gameId), [gameId]);
  const [view, setView] = useState<MarketView | null>(null);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
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
    if (res.ok) setView(res.data);
  }, [api]);

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
    const t = setInterval(refresh, 5000);
    // Stockpile drifts every tick; the "can you cover it" hint only
    // needs to be roughly right.
    const m = setInterval(loadMe, 30000);
    return () => { clearInterval(t); clearInterval(m); };
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
  const shown = useMemo(() => posts.filter(p => {
    if (filter === 'all') return true;
    if (filter === 'mine') return p.mine;
    return (p.offer[filter] ?? 0) > 0;
  }), [posts, filter]);
  const myOpen = posts.filter(p => p.mine).length;
  const atCap = view != null && myOpen >= view.max_open;

  const take = async (post: MarketPost) => {
    setBusyId(post.id);
    setError(null);
    const res = await api.take(post.id);
    setBusyId(null);
    setConfirmId(null);
    if (!res.ok) {
      setError(res.error?.message ?? 'The deal could not be struck.');
      await refresh();
      return;
    }
    setNotice(post.recurring
      ? `Deal struck with ${post.poster_name ?? 'the poster'} — the standing route is under PRIVATE.`
      : `Deal struck with ${post.poster_name ?? 'the poster'} — assign a freighter under PRIVATE to ship your side.`);
    await Promise.all([refresh(), loadMe()]);
  };

  const withdraw = async (post: MarketPost) => {
    setBusyId(post.id);
    setError(null);
    const res = await api.withdraw(post.id);
    setBusyId(null);
    if (!res.ok) setError(res.error?.message ?? 'Could not withdraw that post.');
    await refresh();
  };

  const goTab = (tab: 'market' | 'private') => {
    try { window.dispatchEvent(new CustomEvent('tradedock:tab', { detail: { tab } })); } catch {}
  };

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

      <div className="mkt-chips" role="tablist" aria-label="Filter posts">
        {FILTERS.map(f => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className={`mkt-chip${filter === f.key ? ' is-on' : ''}`}
            title={f.title}
            onClick={() => setFilter(f.key)}
          >{f.label}</button>
        ))}
      </div>

      {error && <div className="mp-error" style={{ marginBottom: 8 }}>{error}</div>}
      {notice && (
        <div className="mkt-notice">
          {notice}{' '}
          <button className="mkt-link" onClick={() => goTab('private')}>Open PRIVATE</button>
        </div>
      )}

      {view != null && shown.length === 0 && (
        <div className="mkt-empty">
          {filter === 'mine'
            ? 'You have nothing on the market.'
            : filter === 'all'
              ? 'The board is empty. Post what you have spare and name your price.'
              : `Nobody is offering ${LABEL[filter as keyof ResourceBundle]} right now.`}
        </div>
      )}

      {shown.map(post => {
        const left = view ? Math.max(0, post.expires_at_tick - view.tick) : 0;
        const rate = marketRate(post);
        const confirming = confirmId === post.id;
        const busy = busyId === post.id;
        const short = me ? KEYS.filter(k => post.request[k] > Number(me[k] ?? 0)) : [];
        return (
          <div key={post.id} className={`mkt-row${post.mine ? ' is-mine' : ''}`}>
            <div className="mkt-row__top">
              <span className="mkt-who">
                <span className="mkt-dot" style={{ background: post.poster_color ?? '#a8b8c8' }} />
                {post.mine ? 'You' : (post.poster_name ?? 'Unknown')}
              </span>
              <span className="mkt-meta">
                {post.recurring && (
                  <span
                    className="mkt-tag"
                    title={post.has_ship
                      ? 'Standing route, per-run amounts. The poster has pinned a freighter — it starts flying when taken.'
                      : 'Standing route, per-run amounts. Each side commissions a freighter after the deal.'}
                  >per run{post.has_ship ? ' · hull ready' : ''}</span>
                )}
                <span title={`Listed until T+${post.expires_at_tick}`}>{left}t left</span>
              </span>
            </div>
            <div className="mkt-terms">
              <span className="mkt-k">Gives</span><span><Bundle b={post.offer} /></span>
              <span className="mkt-k">Wants</span>
              <span>
                <Bundle b={post.request} />
                {rate && <span className="mkt-rate">{rate}</span>}
              </span>
            </div>
            {post.note && <div className="mkt-note">“{post.note}”</div>}

            {confirming ? (
              <div className="mkt-confirm">
                <div>
                  You give <b>{bundleWords(post.request)}</b>{post.recurring ? ' every run' : ''} and
                  get <b>{bundleWords(post.offer)}</b>.
                  {short.length > 0 && (
                    <span className="mkt-warn">
                      {' '}You are short of {short.map(k => LABEL[k]).join(' and ')} — your side will
                      wait at the dock until you can cover it.
                    </span>
                  )}
                </div>
                <div className="mkt-actions">
                  <button className="mp-btn mp-btn--primary" disabled={busy} onClick={() => take(post)}>
                    {busy ? 'Striking…' : 'Confirm'}
                  </button>
                  <button className="mp-btn" disabled={busy} onClick={() => setConfirmId(null)}>Back</button>
                </div>
              </div>
            ) : post.mine ? (
              <div className="mkt-actions">
                <button className="mp-btn" disabled={busy} onClick={() => withdraw(post)}>
                  {busy ? 'Withdrawing…' : 'Withdraw'}
                </button>
              </div>
            ) : (
              <div className="mkt-actions">
                <button
                  className="mp-btn mp-btn--primary"
                  disabled={!!tradeLock || busy}
                  title={tradeLock ?? 'Strike this deal as posted'}
                  onClick={() => { setError(null); setNotice(null); setConfirmId(post.id); }}
                >Take</button>
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
          {tapeOpen && view.recent.map(p => (
            <div key={p.id} className="mkt-tape__row">
              <span style={{ color: p.taken_by_color ?? undefined }}>{p.taken_by_name ?? 'Someone'}</span>
              {' took '}
              <span style={{ color: p.poster_color ?? undefined }}>{p.poster_name ?? 'someone'}</span>
              {'’s '}{bundleWords(p.offer)} for {bundleWords(p.request)}
              {p.recurring ? ' per run' : ''}
              <span className="mkt-dim"> · T+{p.taken_at_tick ?? '?'}</span>
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
