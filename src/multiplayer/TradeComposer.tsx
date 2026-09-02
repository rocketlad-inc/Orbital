// ============================================================
// TradeComposer — modal for drafting a new offer or counter-offer.
//
// Two columns (You give / They give) with numeric inputs for each
// resource and toggles for each pact kind. "Propose" sends to API.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Faction,
  MyFaction,
  PactKind,
  PACT_LABELS,
  ResourceBundle,
  TradeOffer,
  emptyBundle,
  tradesApi,
  apiFetch,
  AssetSellable,
} from './api';
import { hasFeature, requirementFor } from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';

type Mode =
  | { kind: 'new' }
  | { kind: 'counter'; original: TradeOffer };

type Side = 'offer' | 'request';

// EVERY kind the server accepts. construction_pact was missing here and
// nowhere else: the endpoint took it, it was deliberately left ungated,
// constructionPartners() read it, maySupplySite() enforced it in three
// places, /state served it, PACT_LABELS named it and FactionPanel had a
// badge waiting. One absent array entry meant nobody could ever propose
// one — 43 treaties across every live game, none of them this kind —
// so megastructure co-funding sat behind a pact the UI could not form,
// and the refusal told players to go get one.
const PACT_KINDS_ORDER: PactKind[] = ['nap', 'defense_pact', 'intel_share', 'construction_pact'];

/** Pact kinds that cost research. NON-AGGRESSION IS FREE from tick one:
 *  "please stop shooting me" is the most basic diplomatic act there is,
 *  and gating it left two new players with no way to agree to peace
 *  until one reached Industry 4. The pacts that confer an ADVANTAGE
 *  still cost research — a defense pact drags a third party into your
 *  war, and intel-sharing hands over map knowledge the Sensors track
 *  sells. Mirror of GATED_PACTS in worker/trades.js, which is
 *  authoritative and 403s a gated kind regardless of what renders here. */
const GATED_PACT_KINDS = new Set<PactKind>(['defense_pact', 'intel_share']);
// Fuel was removed from the economy. The schema column stays so we don't
// need a migration, but the trade composer no longer offers it as a knob.
const RESOURCE_KEYS: Array<keyof ResourceBundle> = ['metal', 'gold', 'science'];
const RESOURCE_LABELS: Record<keyof ResourceBundle, string> = {
  metal: 'Metal', gold: 'Credits', science: 'Science',
};
const RESOURCE_COLORS: Record<keyof ResourceBundle, string> = {
  metal: '#a0a0a0', gold: '#ffd700', science: '#6ee7b7',
};

interface TradeComposerProps {
  gameId: string;
  me: MyFaction;
  factions: Faction[];
  mode: Mode;
  onClose: () => void;
  onSuccess: () => void;
}

export function TradeComposer({ gameId, me, factions, mode, onClose, onSuccess }: TradeComposerProps) {
  const api = useMemo(() => tradesApi(gameId), [gameId]);

  // NON-AGGRESSION IS FREE; the other two are research-gated. Mirrors
  // GATED_PACTS in worker/trades.js — "please stop shooting me" is the
  // most basic diplomatic act there is, while a defense pact drags a
  // third party into your war and intel-sharing hands over map knowledge
  // the Sensors track sells.
  //
  // `pactLock` is now per-KIND rather than a single lock over the whole
  // section, so the composer can offer NAP to a brand-new empire while
  // still showing the other two as locked. Resource-only trades stay
  // ungated, as before.
  const pactLock = useMemo(() => {
    const enabled = (me.gating_enabled ?? 0) === 1;
    if (hasFeature('pacts', me.tech_levels, enabled)) return null;
    const req = requirementFor('pacts');
    if (!req) return null;
    const track = TECH_DEFS[req.track]?.name ?? req.track;
    return { label: req.label, text: `Unlocks at ${track} ${req.level}` };
  }, [me.tech_levels, me.gating_enabled]);


  // For counters, role flips: "I" become the proposer of the counter. So
  // "what I give" = the original's "request" (what was being asked of me),
  // and "what they give" = the original's "offer".
  const isCounter = mode.kind === 'counter';
  const original = isCounter ? mode.original : null;

  const initialResponderId = isCounter
    ? original!.proposer_faction_id
    : (factions.find((f) => f.id !== me.id)?.id ?? '');

  const [responderId, setResponderId] = useState<string>(initialResponderId);
  const [offer, setOffer] = useState<ResourceBundle>(
    isCounter ? { ...original!.request } : emptyBundle(),
  );
  const [request, setRequest] = useState<ResourceBundle>(
    isCounter ? { ...original!.offer } : emptyBundle(),
  );
  const [offerPacts, setOfferPacts] = useState<PactKind[]>(
    isCounter ? [...original!.request_pacts] : [],
  );
  const [requestPacts, setRequestPacts] = useState<PactKind[]>(
    isCounter ? [...original!.offer_pacts] : [],
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Standing route: same numbers, different meaning — per run instead of
  // once. A counter inherits the original's shape (the server enforces
  // this too: countering haggles the rate, it doesn't convert the deal).
  const [recurring, setRecurring] = useState<boolean>(isCounter ? !!original!.recurring : false);
  // THE HULL THAT STARTS THE RUN (Orbit Man, #general). A standing deal
  // used to be signed and then sit idle until both sides came back and
  // commissioned a leg each. Naming the freighter here means accepting
  // is the whole transaction — the lane is flying, both directions, on
  // this ship, the moment they say yes.
  const [laneShipId, setLaneShipId] = useState<string | null>(null);
  // SELLING A HULL OR A WORLD — the third kind of offer. It runs on its
  // own server lifecycle (the buyer hauls the payment to wherever the
  // asset stands), but from the player's side it is the same act:
  // propose a thing to a faction at a price. So it is a mode of this
  // composer rather than a second one hidden behind its own button.
  const [assetMode, setAssetMode] = useState(false);
  const [sellable, setSellable] = useState<AssetSellable[] | null>(null);
  const [assetRef, setAssetRef] = useState('');
  const [askMetal, setAskMetal] = useState('0');
  const [askCredits, setAskCredits] = useState('0');
  // FETCHED, NOT READ FROM CONTEXT. This composer is rendered by the
  // dock, and MultiplayerShell WRAPS the game-state provider rather
  // than living inside it — so useGameContext() here is not "sometimes
  // empty", it always throws, and taking it out crashed the panel the
  // moment anyone opened a standing offer. The server answers the same
  // question and is the authority on which hulls are free anyway.
  const [freeFreighters, setFreeFreighters] = useState<
    Array<{ id: string; name: string; where: string }>>([]);
  useEffect(() => {
    if (!recurring) return;
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ freighters: Array<{ id: string; name: string; where: string }> }>(
        `/api/games/${gameId}/free-freighters`);
      if (!cancelled && res.ok) setFreeFreighters(res.data?.freighters ?? []);
    })();
    return () => { cancelled = true; };
  }, [gameId, recurring]);

  useEffect(() => {
    // Reset if mode flips
    if (mode.kind === 'new') {
      setOffer(emptyBundle());
      setRequest(emptyBundle());
      setOfferPacts([]);
      setRequestPacts([]);
    }
  }, [mode.kind]);

  const responderName = useMemo(() => {
    return factions.find((f) => f.id === responderId)?.name ?? 'unknown';
  }, [factions, responderId]);

  const responderColor = useMemo(() => {
    return factions.find((f) => f.id === responderId)?.color ?? '#a8b8c8';
  }, [factions, responderId]);

  const offerTotal = RESOURCE_KEYS.reduce((s, k) => s + offer[k], 0) + offerPacts.length;
  const requestTotal = RESOURCE_KEYS.reduce((s, k) => s + request[k], 0) + requestPacts.length;
  const canSubmit = responderId && (offerTotal + requestTotal) > 0 && !submitting;

  // Check whether you actually have what you're offering
  const overspend: Partial<Record<keyof ResourceBundle, number>> = {};
  for (const k of RESOURCE_KEYS) {
    if (offer[k] > me[k]) overspend[k] = me[k];
  }
  const hasOverspend = Object.keys(overspend).length > 0;

  const updateBundle = (side: Side, key: keyof ResourceBundle, value: number) => {
    const v = Math.max(0, Math.floor(value || 0));
    if (side === 'offer') setOffer((b) => ({ ...b, [key]: v }));
    else setRequest((b) => ({ ...b, [key]: v }));
  };
  const togglePact = (side: Side, kind: PactKind) => {
    const setter = side === 'offer' ? setOfferPacts : setRequestPacts;
    setter((arr) => (arr.includes(kind) ? arr.filter((x) => x !== kind) : [...arr, kind]));
  };

  /**
   * One-time vs standing route.
   *
   * Picking a standing route DROPS any ticked pacts. A route carries
   * goods only, so the checkboxes disappear with it — and a ticked box
   * that survives its own control is unreachable state: you'd get "remove
   * the treaty riders" on submit with nothing on screen to remove.
   * Clearing here means the form can never enter that state at all.
   *
   * Going back to a one-time trade does NOT restore them. Silently
   * re-arming a treaty someone stopped seeing several clicks ago is a
   * worse surprise than re-ticking a box.
   */
  // What this faction could put up. Fetched from the same listing the
  // panel uses, so the picker can never offer something the propose
  // endpoint would refuse (a hull under way has no address to be paid
  // at).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api.listAssetDeals();
      if (!cancelled && res.ok) setSellable(res.data.sellable);
    })();
    return () => { cancelled = true; };
  }, [api]);

  const chooseAsset = () => {
    setAssetMode(true);
    setRecurring(false);
    setOfferPacts([]);
    setRequestPacts([]);
    setError(null);
  };

  const chooseKind = (isRoute: boolean) => {
    setAssetMode(false);
    setRecurring(isRoute);
    if (isRoute) {
      setOfferPacts([]);
      setRequestPacts([]);
      // Clear a stale "remove the treaty riders" complaint along with the
      // riders themselves.
      setError(null);
    }
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // A sale is its own transaction on the server. Same button, same
    // recipient picker, different lifecycle underneath.
    if (assetMode) {
      const sep = assetRef.indexOf(':');
      const kind = sep < 0 ? '' : assetRef.slice(0, sep);
      const assetId = sep < 0 ? '' : assetRef.slice(sep + 1);
      if (kind !== 'ship' && kind !== 'settlement') {
        setError('Pick the hull or world you are selling.');
        return;
      }
      const m = Math.max(0, Math.floor(Number(askMetal) || 0));
      const c = Math.max(0, Math.floor(Number(askCredits) || 0));
      if (m <= 0 && c <= 0) {
        setError('Name a price — a free handover is a gift, not a deal.');
        return;
      }
      setSubmitting(true);
      const res = await api.proposeAssetDeal({
        asset_kind: kind,
        asset_id: assetId,
        buyer_faction_id: responderId,
        price_metal: m,
        price_credits: c,
      });
      setSubmitting(false);
      if (!res.ok) {
        setError(res.error?.message ?? 'Failed to offer the sale');
        return;
      }
      onSuccess();
      return;
    }

    if (!canSubmit) return;
    if (hasOverspend) {
      setError('You don\'t hold enough resources to make that offer.');
      return;
    }
    setSubmitting(true);
    // Backstop only. chooseKind() drops the pacts the moment you pick a
    // standing route, and the checkboxes are gone from the form, so the
    // reachable path to this message is a state we don't create. It
    // stays because the server rejects the combination too and a silent
    // 400 is worse than a sentence.
    if (recurring && (offerPacts.length + requestPacts.length) > 0) {
      setError('A standing route carries goods only — remove the treaty riders or make it a one-time trade.');
      setSubmitting(false);
      return;
    }
    if (recurring && !laneShipId) {
      setError('Pick the freighter that will fly this lane — it starts the run the moment they accept.');
      setSubmitting(false);
      return;
    }
    const payload = {
      offer, request,
      offer_pacts: offerPacts,
      request_pacts: requestPacts,
      note: note.trim() || undefined,
      recurring: recurring || undefined,
      ship_id: recurring ? laneShipId ?? undefined : undefined,
    };
    const res = isCounter
      ? await api.counter(original!.id, payload)
      : await api.propose({ ...payload, responder_faction_id: responderId });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error?.message ?? 'Failed to send offer');
      return;
    }
    onSuccess();
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-body)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'rgba(10, 14, 20, 0.98)',
          border: '1px solid #2a3d50',
          borderRadius: 4,
          width: 540, maxWidth: '95vw', maxHeight: '92vh',
          overflow: 'auto',
          boxShadow: '0 16px 64px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: '1px solid #2a3d50',
          background: 'rgba(255, 184, 77, 0.05)',
        }}>
          <div>
            <div style={{
              fontSize: 13, fontWeight: 700, color: '#ffb84d',
              letterSpacing: '0.18em', textTransform: 'uppercase',
            }}>
              {isCounter ? 'Counter Offer' : 'New Trade Offer'}
            </div>
            <div style={{ fontSize: 10, color: '#b8c8d6', marginTop: 2 }}>
              {isCounter ? 'Modify terms and send back' : 'Propose terms to another faction'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid #2a3d50',
              color: '#b8c8d6', cursor: 'pointer', fontSize: 14,
              padding: 0, width: 24, height: 24, borderRadius: 3,
            }}
          >✕</button>
        </div>

        <form onSubmit={submit} style={{ padding: 16, color: '#d8e4ee', fontSize: 11 }}>
          {!isCounter && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
                Negotiating with
              </div>
              <select
                className="mp-select"
                value={responderId}
                onChange={(e) => setResponderId(e.target.value)}
                style={{ width: '100%' }}
              >
                {factions.filter((f) => f.id !== me.id).map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}
          {isCounter && (
            <div style={{ marginBottom: 12, fontSize: 10, color: '#b8c8d6' }}>
              Replying to{' '}
              <span style={{ color: responderColor, fontWeight: 600 }}>{responderName}</span>
            </div>
          )}

          {/* One-time vs standing. A segmented pair, not a checkbox — the
              choice REINTERPRETS every number below it (shipment vs
              per-run rate), which is too big a semantic flip to hang off
              a small square nobody reads. */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {([['one', 'One-time trade', false], ['route', 'Standing route', true]] as const).map(([key, label, val]) => (
              <button
                key={key}
                type="button"
                onClick={() => chooseKind(val)}
                disabled={isCounter}
                title={isCounter ? 'A counter keeps the original\'s shape — haggle the rate, not the kind' : undefined}
                style={(() => {
                  // Three segments, one truth. `recurring` only
                  // distinguishes the first two, so in asset mode it is
                  // still false and ONE-TIME TRADE lit up beside SHIP OR
                  // WORLD -- two segments claiming to be the selection.
                  const on = !assetMode && recurring === val;
                  return {
                    flex: 1, padding: '5px 0', fontSize: 10, cursor: isCounter ? 'default' : 'pointer',
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: on ? 'rgba(110,231,183,0.12)' : 'transparent',
                    color: on ? '#6ee7b7' : '#b8c8d6',
                    border: `1px solid ${on ? '#6ee7b7' : '#2a3d50'}`,
                    borderRadius: 3, opacity: isCounter && !on ? 0.35 : 1,
                  };
                })()}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={chooseAsset}
              disabled={isCounter}
              title={isCounter
                ? 'A counter keeps the shape of the original'
                : 'Sell a hull or a settled world for freight'}
              style={{
                flex: 1, padding: '5px 0', fontSize: 10,
                cursor: isCounter ? 'default' : 'pointer',
                letterSpacing: '0.08em', textTransform: 'uppercase',
                background: assetMode ? 'rgba(110,231,183,0.12)' : 'transparent',
                color: assetMode ? '#6ee7b7' : '#b8c8d6',
                border: `1px solid ${assetMode ? '#6ee7b7' : '#2a3d50'}`,
                borderRadius: 3, opacity: isCounter && !assetMode ? 0.35 : 1,
              }}
            >
              Ship or world
            </button>
          </div>

          {assetMode && (
            <div style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em',
                textTransform: 'uppercase', marginBottom: 4,
              }}>
                Handing over
              </div>
              <select
                className="mp-select"
                value={assetRef}
                onChange={e => setAssetRef(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              >
                <option value="">
                  {sellable === null ? 'Loading…' : 'Pick a hull or a world…'}
                </option>
                {(sellable ?? []).map(s => (
                  <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
                    {s.label}{s.where ? ` — ${s.where}` : ''}
                  </option>
                ))}
              </select>
              {sellable !== null && sellable.length === 0 && (
                <div style={{ fontSize: 10, color: '#b8c8d6', marginBottom: 8 }}>
                  Nothing parked that you could hand over. A hull under way
                  has no address to be paid at.
                </div>
              )}
              <div style={{
                fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em',
                textTransform: 'uppercase', marginBottom: 4,
              }}>
                Asking
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="mp-input"
                  type="number"
                  min={0}
                  value={askMetal}
                  onChange={e => setAskMetal(e.target.value)}
                  aria-label="Asking price in metal"
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 10, color: '#b8c8d6' }}>metal</span>
                <input
                  className="mp-input"
                  type="number"
                  min={0}
                  value={askCredits}
                  onChange={e => setAskCredits(e.target.value)}
                  aria-label="Asking price in credits"
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 10, color: '#b8c8d6' }}>credits</span>
              </div>
              <div style={{
                fontSize: 10, color: '#b8c8d6', marginTop: 8, lineHeight: 1.5,
                borderLeft: '2px solid #6ee7b7', paddingLeft: 8,
              }}>
                They haul the payment to where it stands now. It changes
                hands when the last of it arrives.
              </div>
            </div>
          )}

          {!assetMode && recurring && (
            <div style={{
              fontSize: 10, color: '#b8c8d6', marginBottom: 10, lineHeight: 1.5,
              borderLeft: '2px solid #6ee7b7', paddingLeft: 8,
            }}>
              Amounts below ship <b style={{ color: '#6ee7b7' }}>every run</b>, on the freighter
              you pin below — it collects at your dock, delivers to theirs, loads their
              side and brings it home, over and over. It repeats until either of you
              cancels — or war, a lost freighter, or an empty treasury ends it. Goods
              only; no treaty riders.
            </div>
          )}

          {recurring && (
            <div style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: '#7a8a9a', marginBottom: 6,
              }}>
                Freighter that flies it
              </div>
              {freeFreighters.length === 0 ? (
                <div style={{ fontSize: 11, color: '#ff9b9b', lineHeight: 1.5 }}>
                  Every freighter you have is already on a route. Free one up, or build
                  another, before proposing a standing lane.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {freeFreighters.map(f => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setLaneShipId(f.id === laneShipId ? null : f.id)}
                      title={`${f.name} — ${f.where}`}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                        gap: 1, padding: '5px 9px', borderRadius: 3, cursor: 'pointer',
                        background: laneShipId === f.id ? 'rgba(110,231,183,0.12)' : 'transparent',
                        border: `1px solid ${laneShipId === f.id ? '#6ee7b7' : '#2a3d50'}`,
                        color: laneShipId === f.id ? '#6ee7b7' : '#b8c8d6',
                        font: 'inherit', fontSize: 11,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{f.name}</span>
                      <span style={{ fontSize: 9, color: '#7a8a9a' }}>{f.where}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ColumnEditor
              title="You give"
              titleColor="#ffb84d"
              bundle={offer}
              pacts={offerPacts}
              showPacts={!recurring}
              onResource={(k, v) => updateBundle('offer', k, v)}
              onTogglePact={(p) => togglePact('offer', p)}
              pactLock={pactLock}
              hint={me
                // Round for display: server-side per-tick drains leave
                // fp residue (a player saw "4.440892098500626e-16
                // science" here). Stocks always read as whole numbers.
                // Label via RESOURCE_LABELS, not the raw key — the key
                // is the server's 'gold', the player-facing name is
                // 'credits' (this line was the last place still
                // printing "gold").
                ? `Your stockpile: ${RESOURCE_KEYS.map(k => `${Math.round(Number(me[k]) || 0)} ${RESOURCE_LABELS[k].toLowerCase()}`).join(' · ')}`
                : undefined}
              overspend={overspend}
            />
            <ColumnEditor
              title="They give"
              titleColor="#4ecdc4"
              bundle={request}
              pacts={requestPacts}
              showPacts={!recurring}
              onResource={(k, v) => updateBundle('request', k, v)}
              onTogglePact={(p) => togglePact('request', p)}
              pactLock={pactLock}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
              Note (optional)
            </div>
            <textarea
              className="mp-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              style={{ width: '100%' }}
              placeholder="Add a message to the offer…"
            />
          </div>

          {error && (
            <div className="mp-error" style={{ marginTop: 8 }}>{error}</div>
          )}

          {/* Buttons on their own row, sized to content (were stretching
              to fill a tall flex row the helper text was inflating).
              Helper text sits BELOW them. */}
          <div style={{
            display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end',
          }}>
            <button
              type="button"
              className="mp-btn"
              style={{ padding: '7px 16px', fontSize: 12 }}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="mp-btn mp-btn--primary"
              style={{ padding: '7px 16px', fontSize: 12 }}
              disabled={!canSubmit || hasOverspend}
            >
              {isCounter ? 'Send Counter' : 'Send Offer'}
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 9, color: '#8aa0b4', lineHeight: 1.5 }}>
            Pacts take effect the moment the deal is accepted. Resources are
            DELIVERED: each side loads its goods onto a freighter at one of
            its terraformed worlds and flies them to the other's — assign
            ships in the Trades panel's Shipments tab after acceptance.
          </div>
        </form>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------

function ColumnEditor({
  title, titleColor, bundle, pacts, onResource, onTogglePact, hint, overspend, pactLock,
  showPacts = true,
}: {
  title: string;
  titleColor: string;
  bundle: ResourceBundle;
  pacts: PactKind[];
  /** False on a standing route, which carries goods only. The section is
   *  REMOVED rather than disabled: a greyed-out control invites you to
   *  wonder what would unlock it, and the answer here is "nothing — this
   *  kind of deal has no treaty riders at all". */
  showPacts?: boolean;
  onResource: (k: keyof ResourceBundle, v: number) => void;
  onTogglePact: (p: PactKind) => void;
  hint?: string;
  overspend?: Partial<Record<keyof ResourceBundle, number>>;
  /** Non-null → pacts are research-locked; carries the unlock label. */
  pactLock?: { label: string; text: string } | null;
}) {
  return (
    <div style={{
      border: '1px solid #2a3d50',
      borderRadius: 3,
      padding: 10,
      background: 'rgba(78, 205, 196, 0.03)',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: titleColor,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        marginBottom: 8, paddingBottom: 4,
        borderBottom: '1px solid #2a3d50',
      }}>
        {title}
      </div>

      {RESOURCE_KEYS.map((k) => {
        const isOver = overspend && overspend[k] != null;
        return (
          <div key={k} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 4,
          }}>
            <span style={{ color: RESOURCE_COLORS[k], fontSize: 10 }}>
              {RESOURCE_LABELS[k]}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={bundle[k]}
              onChange={(e) => onResource(k, Number(e.target.value))}
              style={{
                width: 64, padding: '3px 6px',
                background: 'rgba(10, 14, 20, 0.6)',
                border: `1px solid ${isOver ? '#ff5e5e' : '#2a3d50'}`,
                color: isOver ? '#ff5e5e' : '#d8e4ee',
                fontFamily: 'inherit', fontSize: 10,
                borderRadius: 2, textAlign: 'right',
                outline: 'none',
              }}
            />
          </div>
        );
      })}

      {showPacts && (<>
      <div style={{
        fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em',
        textTransform: 'uppercase', marginTop: 8, marginBottom: 4,
      }}>
        Pacts
      </div>
      {/* Only the ADVANTAGE pacts are research-locked; non-aggression is
          free from tick one, so the banner no longer says "Pacts unlock
          at…" over a section whose first entry is available right now. */}
      {pactLock && (
        <div style={{
          fontSize: 8.5, lineHeight: 1.4, color: '#ffb84d',
          border: '1px solid rgba(255, 184, 77, 0.4)', borderRadius: 3,
          background: 'rgba(255, 184, 77, 0.06)', padding: '5px 7px', marginBottom: 5,
        }}>
          🔒 Defense &amp; intel pacts unlock at <b>{pactLock.text.replace(/^Unlocks at\s*/i, '')}</b>.
          {' '}Non-aggression and resource trades work now.
        </div>
      )}
      {PACT_KINDS_ORDER.map((p) => {
        const selected = pacts.includes(p);
        // Per-KIND: non-aggression is free, the other two cost research.
        // Keep GATED_PACT_KINDS in sync with GATED_PACTS in
        // worker/trades.js — the server is authoritative and will 403 a
        // gated kind regardless of what this renders.
        const locked = GATED_PACT_KINDS.has(p) && !!pactLock;
        return (
          <label
            key={p}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, padding: '2px 0',
              cursor: locked ? 'not-allowed' : 'pointer',
              color: locked ? '#5a6a78' : selected ? '#4ecdc4' : '#a8b8c8',
            }}
            title={locked ? `${pactLock!.label} — ${pactLock!.text}` : undefined}
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={locked}
              onChange={() => onTogglePact(p)}
            />
            {PACT_LABELS[p]}
          </label>
        );
      })}
      </>)}

      {hint && (
        <div style={{ fontSize: 8, color: '#b8c8d6', marginTop: 6, fontStyle: 'italic' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
