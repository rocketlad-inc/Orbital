import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiFetch, realSuffix,
  ActiveLaw, Faction, LawPhrase, SenateProposal, SenateSession, SenateSlider,
} from './api';
import { logUiEvent } from './telemetry';
import { DiscordLink } from './DiscordLink';
import { FactionEmblem } from '../components/FactionEmblem';
import { hasFeature, requirementFor } from '../game/researchUnlocks';
import { TECH_DEFS } from '../game/techs';
import { t, tn, tk } from '../i18n/core';
import type { Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import { apiErrorText } from '../i18n/apiErrors';

/** A translated sentence with React nodes (a bold name) standing in its
 *  {placeholders}; plain text placeholders go through t() as usual. */
function rich(key: Key, parts: Record<string, React.ReactNode>): React.ReactNode[] {
  return t(key).split(/\{(\w+)\}/g).map((s, i) => (i % 2 === 1
    ? <React.Fragment key={i}>{parts[s] ?? `{${s}}`}</React.Fragment>
    : s));
}

/** "5 ticks · ~5h": fmtTicksReal's wall-clock arithmetic with the word
 *  "ticks" in the player's language. */
function ticksReal(ticks: number, tickMs?: number | null): string {
  const base = tn('senate.ticks', ticks);
  if (!tickMs || tickMs <= 0 || ticks <= 0) return base;
  const ms = ticks * tickMs;
  const mins = ms / 60_000;
  const hours = ms / 3_600_000;
  const human = mins < 60
    ? `~${Math.max(1, Math.round(mins))}m`
    : hours < 48
      ? `~${Math.round(hours)}h`
      : `~${Math.round(hours / 24)}d`;
  return `${base} · ${human}`;
}

/** What a player reads for a ballot direction. */
const voteWord = (v: string): string => tk(`senate.vote.${v}`, v);

// Per-proposal duration bounds. The MINIMUM is six real hours for each
// phase, which in ticks depends on the game's cadence — so the server
// sends it (min_window_ticks) rather than the client keeping a second
// copy of the rule. These are only the fallbacks used before the first
// /senate/sliders response lands; the server clamps regardless.
const VOTE_MAX_FALLBACK   = 24;

/** Bill kinds the server accepts. Slider law is the legacy default.
 *  Targeted sanctions plus the Chancellor election bill all carry a
 *  faction-id pointer; we drive the right composer fields off this. */
type BillKind =
  | 'slider_law'
  | 'trade_embargo'
  | 'war_authorization'
  | 'production_sanction'
  | 'reparations'
  | 'chancellor_vote'
  | 'repeal_law';

// Plain-language menu. These were named after their internals — "Slider
// Law (global multiplier)", "Production Sanction (½ target yield, 14t)"
// — which describes the machinery rather than the decision. Each now
// says what the bill DOES and, where it matters, how long for.
const BILL_KIND_LABELS: Record<BillKind, Key> = {
  slider_law:          'senate.bill.slider_law',
  trade_embargo:       'senate.bill.trade_embargo',
  war_authorization:   'senate.bill.war_authorization',
  production_sanction: 'senate.bill.production_sanction',
  reparations:         'senate.bill.reparations',
  chancellor_vote:     'senate.bill.chancellor_vote',
  repeal_law:          'senate.bill.repeal_law',
};

/** Bill kinds that need a faction id in their payload. Drives the target
 *  picker render below; chancellor_vote uses candidate_faction_id, the
 *  rest use target_faction_id. */
const NEEDS_TARGET: Record<BillKind, boolean> = {
  slider_law:          false,
  trade_embargo:       true,
  war_authorization:   true,
  production_sanction: true,
  reparations:         true,
  chancellor_vote:     true,
  // Repeal aims at a LAW, not a faction — it has its own picker.
  repeal_law:          false,
};

const STATUS_COLORS: Record<SenateProposal['status'], string> = {
  debating:  '#ffb84d',   // amber: still cooking
  voting:    '#6ee7b7',   // green: act now
  passed:    '#4ecdc4',
  failed:    '#ff5e5e',
  withdrawn: '#8a9fb3',
};

/** Shape of GET /senate/weight. Mirrors weightBreakdown() in
 *  worker/systems.js. */
type WeightDetail = {
  weight: number;
  base: number;
  rule: string;
  controlled: { label: string; held: number; total: number }[];
  contesting: { label: string; held: number; total: number; need: number; contested: boolean }[];
};

/**
 * "Your vote is worth N, and here is exactly why."
 *
 * Weight used to be one vote per body owned, which nobody could see and
 * which quietly rewarded hoovering up moons. It is now 1 + one per
 * SYSTEM controlled — a number small enough to reason about, attached to
 * places players already fight over. Showing the arithmetic here is the
 * whole point: a tally reading "Yea 4 (2 votes)" only makes sense if you
 * know where your own 3 came from.
 *
 * The "one more body to take it" list is deliberate. It turns an
 * explanation into a target list.
 */
function WeightCard({ detail }: { detail: WeightDetail | null }) {
  useI18n();
  if (!detail) return null;
  const near = detail.contesting.filter(s => s.need <= 1);
  return (
    <div style={{
      border: '1px solid var(--mp-border)', borderRadius: 5,
      padding: 11, marginBottom: 14, marginTop: 14,
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: 'rgba(255, 255, 255, 0.02)',
    }}>
      {/* Mockup layout: the number is the headline, the prose is the
          caption. */}
      <span style={{ fontSize: 26, color: '#6ee7b7', lineHeight: 1.1, flex: '0 0 auto' }}>
        ★{detail.weight}
      </span>
      <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--mp-fg)', fontWeight: 600 }}>
        {t('senate.weight.title')}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--mp-fg-dim)', marginTop: 3, lineHeight: 1.55 }}>
        {detail.rule}
      </div>
      <div style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.6 }}>
        <span style={{ color: 'var(--mp-fg-dim)' }}>{t('senate.weight.base', { n: detail.base })}</span>
        {detail.controlled.length > 0 ? (
          <>
            <span style={{ color: 'var(--mp-fg-dim)' }}> + </span>
            {detail.controlled.map((s, i) => (
              <span key={s.label}>
                {i > 0 && <span style={{ color: 'var(--mp-fg-dim)' }}> + </span>}
                <span style={{ color: '#6ee7b7' }} title={t('senate.weight.held', { held: s.held, total: s.total })}>
                  {s.label}
                </span>
              </span>
            ))}
          </>
        ) : (
          <span style={{ color: 'var(--mp-fg-dim)' }}>{' '}{t('senate.weight.none')}</span>
        )}
      </div>
      {near.length > 0 && (
        <div style={{ fontSize: 10.5, color: '#ffb84d', marginTop: 6, lineHeight: 1.6 }}>
          {t('senate.weight.near', { labels: near.map(s => s.label).join(', ') })}
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * Who holds the gavel and how long they have.
 *
 * Deliberately does NOT draw its own roster: <Chamber> already renders
 * one, weighted by votes, and it now carries the seated/absent state
 * too. Two rosters on one tab would be two places to look for the same
 * answer, and they would inevitably disagree.
 */
function SessionCard({ session, factions, myFactionId, tickMs }: {
  session: SenateSession | null;
  factions: Faction[];
  myFactionId: string | null;
  tickMs: number | null;
}) {
  useI18n();
  // Defensive against a version skew during rollout: for ~40s after a
  // deploy a new bundle can be talking to the old worker, which returns
  // no session at all — and a half-populated one is just as possible if
  // this ever ships ahead of a server field.
  if (!session?.quorum) return null;
  const byId = new Map(factions.map(f => [f.id, f]));
  const term = session.term;
  const chair = term ? byId.get(term.faction_id) : null;
  const waitingCount = (session.awaiting_turn ?? []).length;
  const iAmWaiting = !!myFactionId && (session.awaiting_turn ?? []).includes(myFactionId);

  return (
    <div style={{
      border: '1px solid var(--mp-border)', borderRadius: 4,
      padding: '8px 10px', marginBottom: 10,
      background: session.is_chairman ? 'rgba(110,231,183,0.07)' : 'rgba(255,255,255,0.03)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span>🔨</span>
        {term && chair ? (
          <>
            <span className="mp-swatch" style={{ background: chair.color }} />
            <strong>{session.is_chairman ? t('senate.session.youGavel') : t('senate.session.theyGavel', { name: chair.name })}</strong>
          </>
        ) : (
          <strong>{t('senate.session.none')}</strong>
        )}
      </div>
      {term && (
        <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 3 }}>
          {t('senate.session.term', { n: term.term_index + 1, left: term.ticks_remaining, total: session.term_ticks })}{realSuffix(term.ticks_remaining, tickMs)}
          {(session.open_bills ?? 0) > 0 && ` · ${t('senate.session.votesOpen', { open: session.open_bills ?? 0, max: session.max_open_bills ?? 3 })}`}
        </div>
      )}
      {session.is_chairman && (
        <div style={{ fontSize: 10, color: session.can_propose ? '#6ee7b7' : '#ffb84d', marginTop: 3 }}>
          {session.can_propose
            ? t('senate.session.agenda', { left: session.bills_left_this_term ?? session.bills_per_term ?? 2, per: session.bills_per_term ?? 2 })
            : session.cannot_propose_reason}
        </div>
      )}

      {/* Where you sit in the rotation. Not a queue — the draw is random
          within a cycle — so this says "still to come", not "you're
          next", which would be a promise the bag doesn't make. */}
      {!session.is_chairman && term && (
        <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 3 }}>
          {iAmWaiting
            ? t('senate.session.waiting', { n: waitingCount })
            : t('senate.session.held')}
        </div>
      )}
    </div>
  );
}

/**
 * The law of the land — every slider law currently in force.
 *
 * A passed bill used to leave no standing trace anywhere in the client:
 * the effect quietly re-priced the economy and the senate went back to
 * showing only what was being voted on next. Players who passed a
 * half-price shipbuilding law had no way to confirm it was doing
 * anything, which reads exactly like a broken feature.
 *
 * Renders nothing when no law is in force. That is the common state and
 * an empty "Laws in force (0)" header would be permanent furniture
 * announcing an absence.
 */
function LawsCard({ laws, tickMs, onRepeal }: {
  laws: ActiveLaw[];
  tickMs: number | null;
  /** Move to strike this law down. Absent = no repeal affordance (the
   *  chamber gate is closed, or the caller doesn't offer it). */
  onRepeal?: (law: ActiveLaw) => void;
}) {
  useI18n();
  if (laws.length === 0) return null;
  return (
    <div style={{
      border: '1px solid rgba(255,207,112,0.35)', borderRadius: 4,
      padding: '8px 10px', marginBottom: 10,
      background: 'rgba(255,207,112,0.06)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#ffcf70', marginBottom: 6 }}>
        {t('senate.laws.title')}
      </div>
      {laws.map((law) => (
        <div
          key={`${law.slider_id}:${law.proposal_id ?? 'x'}:${law.target_faction_id ?? 'all'}`}
          style={{ fontSize: 11, lineHeight: 1.5, marginBottom: 7 }}
        >
          {/* Line 1: the law's NAME and how long it has left. The name
              carries the direction ("Cheaper Ships" vs "Pricier Ships"),
              so no arrow or percentage is needed to read the headline. */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <strong style={{ color: '#ffcf70' }}>
              {law.law_name ?? law.label}
            </strong>
            {law.target_faction_id && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: 'var(--mp-fg-dim)' }}>{t('senate.laws.on')}</span>
                <FactionEmblem
                  emblem={law.target_emblem}
                  fallbackKey={law.target_faction_id}
                  size={11}
                  color={law.target_color ?? '#9fb4c6'}
                />
                <span style={{ color: law.target_color ?? 'var(--mp-fg)' }}>
                  {law.target_name ?? t('senate.laws.aFaction')}
                </span>
              </span>
            )}
            <span style={{ color: 'var(--mp-fg-dim)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
              {tn('senate.laws.ticksLeft', law.ticks_left)}{realSuffix(law.ticks_left, tickMs)}
            </span>
          </div>
          {/* Line 2: what it actually does, in one sentence, from the
              server's vocabulary. This is the line that replaced
              "Ship Build Cost Multiplier −50%". */}
          <div style={{ color: 'var(--mp-fg)' }}>
            {law.effect_text
              ?? t('senate.laws.setTo', { label: law.label, value: law.value })}
            {!law.target_faction_id && (
              <span style={{ color: 'var(--mp-fg-dim)' }}> {t('senate.laws.everyone')}</span>
            )}
          </div>
          {/* Line 3: the bill it came from, so a law reads as the
              argument that produced it rather than a setting someone
              changed. Quoted because it's a player's own words. */}
          {law.proposal_title && (
            <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)' }}>
              {t('senate.laws.passedAs', { title: law.proposal_title })}
            </div>
          )}
          {/* Line 4: the way out. A law now stands for a full term, so
              without this the only answer to a bad law was to wait it
              out. Sits on the law itself because that's where the player
              forms the opinion. */}
          {onRepeal && law.proposal_id && (
            <button
              onClick={() => onRepeal(law)}
              title={t('senate.laws.repealTip', { title: law.proposal_title ?? law.law_name ?? '' })}
              style={{
                marginTop: 3,
                background: 'transparent',
                border: '1px solid rgba(255,94,94,0.5)',
                borderRadius: 3,
                color: '#ff8080',
                fontFamily: 'inherit',
                fontSize: 9,
                letterSpacing: '0.1em',
                padding: '2px 7px',
                cursor: 'pointer',
              }}
              data-testid={`law-repeal-${law.proposal_id}`}
            >
              {t('senate.laws.repeal')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<SenateProposal['status'], Key> = {
  debating:  'senate.status.debating',
  voting:    'senate.status.voting',
  passed:    'senate.status.passed',
  failed:    'senate.status.failed',
  withdrawn: 'senate.status.withdrawn',
};

export function SenatePanel({
  gameId,
}: {
  gameId: string;
}) {
  useI18n();
  useEffect(() => { logUiEvent(gameId, 'senate'); }, [gameId]);
  const [sliders, setSliders] = useState<SenateSlider[]>([]);
  const [currentTick, setCurrentTick] = useState<number>(0);
  const [proposals, setProposals] = useState<SenateProposal[]>([]);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [myFactionId, setMyFactionId] = useState<string | null>(null);
  const [session, setSession] = useState<SenateSession | null>(null);
  /** Slider laws currently in force. Empty is the normal state. */
  const [laws, setLaws] = useState<ActiveLaw[]>([]);
  /** Wall-clock length of one tick, from the server. Null until known. */
  const [tickMs, setTickMs] = useState<number | null>(null);
  const [weight, setWeight] = useState<WeightDetail | null>(null);
  const [voting, setVoting] = useState<string | null>(null);
  /** Total weight in the chamber — the denominator every turnout and
   *  coalition number is measured against. */
  const chamberWeight = useMemo(
    () => factions.reduce((n, f) => n + voteWeightOf(f), 0),
    [factions],
  );
  /** Ballots already cast on the bill currently open for voting — drives
   *  the outlined "hasn't voted" seats. Null when nothing is on the
   *  floor, so the seat map falls back to plain colours. */
  /** How each faction voted on the bill currently on the floor.
   *  Null when nothing is being voted on. The DIRECTION matters, not
   *  just the fact of a ballot — the chamber splits seats by it. */
  //
  // SEVERAL CAN BE OPEN (a47ef974: up to three). The seat map can show
  // one, so it shows the one closing SOONEST and names it -- it used to
  // take whichever came first in the list, unlabelled, so the outlined
  // "not voted" seats were right for one bill and wrong for the others.
  const floorBill = useMemo(() => {
    const open = proposals.filter(p => p.status === 'voting');
    if (open.length === 0) return null;
    return [...open].sort((a, b) => a.vote_closes_at_tick - b.vote_closes_at_tick)[0];
  }, [proposals]);
  const openVoteCount = useMemo(
    () => proposals.filter(p => p.status === 'voting').length, [proposals]);
  const floorBallots = useMemo(() => {
    if (!floorBill) return null;
    const m = new Map<string, 'yea' | 'nay' | 'abstain'>();
    for (const b of floorBill.ballots ?? []) m.set(b.faction_id, b.vote);
    return m;
  }, [floorBill]);
  const [myTech, setMyTech] = useState<{ levels: Record<string, number>; gating: boolean }>(
    { levels: {}, gating: false },
  );

  // Composer state
  const [kind, setKind] = useState<BillKind>('slider_law');
  const [sliderId, setSliderId] = useState<string>('');
  const [target, setTarget] = useState<number>(1);
  const [targetFactionId, setTargetFactionId] = useState<string>('');
  // Kept SEPARATE from targetFactionId. That one is a required choice for
  // sanctions and clears to "— choose —"; this one is optional and empty
  // means "everyone", which is a valid submission. Sharing one field
  // would make an un-chosen sanction and a general law indistinguishable.
  const [sliderTargetId, setSliderTargetId] = useState<string>('');
  /** Law being moved against, for a repeal bill. Set by the REPEAL button
   *  on a row of LAW OF THE LAND — you repeal the law you are reading,
   *  rather than re-finding it in a dropdown. */
  const [repealTargetId, setRepealTargetId] = useState<string>('');
  const [repealTargetName, setRepealTargetName] = useState<string>('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  // Seeded at 1 and raised to the server's floor as soon as the first
  // sliders response lands (see refresh()). Starting AT a guessed floor
  // would show a number that's wrong for this game's cadence. There is
  // no debate phase any more: a bill opens straight into voting.
  const [minVote, setMinVote] = useState<number>(1);
  /** Credits a reparations target hands EACH other living faction.
   *  Server-sent (see senate.js) rather than mirrored: it is quoted to
   *  voters, and a stale copy would misstate what a bill actually does. */
  const [reparationsPer, setReparationsPer] = useState<number | null>(null);
  /** What the chairman may name per recipient, server-sent like the figure above. */
  const [reparationsRange, setReparationsRange] = useState<{ min: number; max: number }>({ min: 1, max: 5000 });
  /** The chairman's figure for a reparations bill. Blank = the server's default (reparationsPer). */
  const [repAmount, setRepAmount] = useState<string>('');
  const [voteMax, setVoteMax] = useState<number>(VOTE_MAX_FALLBACK);
  const [voteTicks, setVoteTicks] = useState<number>(1);

  // Research gate, MIRRORED from worker/senate.js. Slider laws are
  // ungated — the gavel already rations who may speak, and gating on top
  // of it rationed twice and left the early senate dead. Sanctions need
  // 'senate.propose' (Industry 5); the Chancellor election needs
  // 'senate.chancellor' (Industry 6). VOTING is never gated.
  //
  // KEEP IN SYNC with the server. A client that offers a bill the server
  // rejects reads as a broken button, and one that hides a bill the
  // server would allow silently removes a move from the game.
  const proposeLock = useMemo(() => {
    const feat = kind === 'chancellor_vote' ? 'senate.chancellor'
               : kind === 'slider_law'      ? null
               : 'senate.propose';
    if (!feat) return null;
    if (hasFeature(feat, myTech.levels, myTech.gating)) return null;
    const req = requirementFor(feat);
    if (!req) return null;
    const track = TECH_DEFS[req.track]?.name ?? req.track;
    return { label: req.label, tier: `${track} ${req.level}` };
  }, [kind, myTech]);

  const refresh = useCallback(async () => {
    const [sRes, pRes, fRes, wRes] = await Promise.all([
      apiFetch<{
        sliders: SenateSlider[]; current_tick: number;
        min_window_ticks?: number; debate_max_ticks?: number; vote_max_ticks?: number;
        min_debate_ticks?: number; min_vote_ticks?: number;
        reparations_per_faction?: number;
        reparations_min_per_faction?: number;
        reparations_max_per_faction?: number;
      }>(`/api/games/${gameId}/senate/sliders`),
      apiFetch<{
        proposals: SenateProposal[]; session?: SenateSession;
        tick_interval_ms?: number | null; laws?: ActiveLaw[];
      }>(`/api/games/${gameId}/senate/proposals`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
      apiFetch<WeightDetail>(`/api/games/${gameId}/senate/weight`),
    ]);
    if (sRes.ok) {
      setSliders(sRes.data.sliders);
      setCurrentTick(sRes.data.current_tick);
      // Adopt the server's vote floor, and pull the input up to it so the
      // composer can't sit on a value the server will silently raise.
      // min_window_ticks stays the fallback for an older server.
      const vFloor = sRes.data.min_vote_ticks ?? sRes.data.min_window_ticks;
      if (typeof sRes.data.reparations_per_faction === 'number') {
        setReparationsPer(sRes.data.reparations_per_faction);
      }
      if (typeof sRes.data.reparations_min_per_faction === 'number' && typeof sRes.data.reparations_max_per_faction === 'number') {
        setReparationsRange({ min: sRes.data.reparations_min_per_faction, max: sRes.data.reparations_max_per_faction });
      }
      if (typeof vFloor === 'number' && vFloor > 0) {
        setMinVote(vFloor);
        setVoteMax(sRes.data.vote_max_ticks ?? Math.max(VOTE_MAX_FALLBACK, vFloor));
        setVoteTicks((v) => Math.max(v, vFloor));
      }
      if (!sliderId && sRes.data.sliders.length) {
        setSliderId(sRes.data.sliders[0].id);
        setTarget(sRes.data.sliders[0].default);
      }
    }
    if (pRes.ok) {
      setProposals(pRes.data.proposals);
      setSession(pRes.data.session ?? null);
      setTickMs(pRes.data.tick_interval_ms ?? null);
      setLaws(pRes.data.laws ?? []);
    }
    if (fRes.ok) setFactions(fRes.data.factions);
    if (wRes.ok) setWeight(wRes.data);
  }, [gameId, sliderId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  // Learn caller's faction id once so the Withdraw button knows when
  // to show (proposer-only on the server side; client mirrors to
  // avoid a confusing 403 click).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ faction: { id: string; tech_levels?: Record<string, number>; gating_enabled?: number } }>(`/api/games/${gameId}/me`);
      if (!cancelled && res.ok && res.data?.faction?.id) {
        setMyFactionId(res.data.faction.id);
        setMyTech({
          levels: res.data.faction.tech_levels ?? {},
          gating: (res.data.faction.gating_enabled ?? 0) === 1,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [gameId]);

  // External refresh — MultiplayerShell broadcasts a 'mp:senate-refresh'
  // window event when a WS notification arrives, so the panel reacts
  // immediately instead of waiting for the next 5s poll.
  useEffect(() => {
    const onExternal = () => { void refresh(); };
    window.addEventListener('mp:senate-refresh', onExternal);
    return () => window.removeEventListener('mp:senate-refresh', onExternal);
  }, [refresh]);

  const factionsById = useMemo(() => {
    const m = new Map<string, Faction>();
    for (const f of factions) m.set(f.id, f);
    return m;
  }, [factions]);

  const selectedSlider = useMemo(
    () => sliders.find((s) => s.id === sliderId) ?? null,
    [sliders, sliderId],
  );

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !summary.trim()) {
      setError(t('senate.err.titleSummary'));
      return;
    }
    // Per-kind body shape — server validates each branch in
    // buildBillPayload (worker/senate.js). Mirror the same field names
    // here so a 400 surfaces as a real message instead of an opaque
    // "bad request" the user can't act on.
    const body: Record<string, unknown> = {
      kind,
      title: title.trim(),
      summary: summary.trim(),
      vote_ticks: voteTicks,
    };
    if (kind === 'slider_law') {
      if (!selectedSlider) { setError(t('senate.err.pickSlider')); return; }
      body.slider_id = selectedSlider.id;
      body.target_value = target;
      // Omitted entirely when empty: the server reads a missing/blank
      // target_faction_id as "general law", which is the default.
      if (sliderTargetId) body.target_faction_id = sliderTargetId;
    } else if (kind === 'repeal_law') {
      // Aims at a LAW, not a faction. The id comes from the Repeal button
      // on the law itself (LawsCard), so an empty one means the player
      // switched the kind by hand without picking a target.
      if (!repealTargetId) {
        setError(t('senate.err.pickLaw'));
        return;
      }
      body.target_proposal_id = repealTargetId;
    } else if (kind === 'chancellor_vote') {
      if (!targetFactionId) { setError(t('senate.err.pickCandidate')); return; }
      // The chancellor bill is ONE-SHOT per faction: a failed bid burns
      // your only attempt forever. That consequence lived in a server
      // comment and nowhere in the UI (usability report) — make the
      // player say it out loud before the die is cast.
      const candidateName = factions.find(f => f.id === targetFactionId)?.name ?? t('senate.compose.theCandidate');
      const confirmed = window.confirm(t('senate.chancellor.confirm', { name: candidateName }));
      if (!confirmed) return;
      body.candidate_faction_id = targetFactionId;
    } else {
      // Targeted sanctions: trade_embargo, war_authorization,
      // production_sanction, reparations
      if (!targetFactionId) { setError(t('senate.err.pickTarget')); return; }
      if (targetFactionId === myFactionId) {
        setError(t('senate.err.noSelf'));
        return;
      }
      body.target_faction_id = targetFactionId;
      if (kind === 'reparations') {
        // The chairman names how much each recipient gets. Blank sends
        // nothing and the server uses its default, the same figure the
        // field's placeholder shows.
        if (repAmount.trim() !== '') {
          const n = Number(repAmount);
          if (!Number.isInteger(n) || n < reparationsRange.min || n > reparationsRange.max) {
            setError(t('senate.err.repAmount', { min: fmtNum(reparationsRange.min), max: fmtNum(reparationsRange.max) }));
            return;
          }
          body.amount_per_faction = n;
        }
      }
    }
    setBusy(true);
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) { setError(apiErrorText(res.error, 'senate.err.propose')); return; }
    setTitle(''); setSummary('');
    setTargetFactionId(''); setSliderTargetId(''); setRepAmount('');
    // Reset to the floor, not to a legacy default below it.
    setVoteTicks(minVote);
    refresh();
  }

  async function castVote(proposalId: string, vote: 'yea' | 'nay' | 'abstain') {
    setError(null);
    // The buttons sit on the card and the list refreshes underneath them,
    // so without a lock an impatient double-click fires two ballots.
    setVoting(proposalId);
    try {
      const res = await apiFetch(`/api/games/${gameId}/senate/proposals/${proposalId}/vote`, {
        method: 'POST',
        body: JSON.stringify({ vote }),
      });
      if (!res.ok) setError(apiErrorText(res.error, 'senate.err.vote'));
      refresh();
    } finally {
      setVoting(null);
    }
  }

  async function withdraw(proposalId: string) {
    setError(null);
    const res = await apiFetch(`/api/games/${gameId}/senate/proposals/${proposalId}/withdraw`, {
      method: 'POST',
    });
    if (!res.ok) setError(apiErrorText(res.error, 'senate.err.withdraw'));
    refresh();
  }

  // Caller's own faction id is needed to gate the Withdraw button. We
  // know it by looking up which proposal the caller proposed AND has
  // a faction row (the proposer_faction_id field on those proposals).
  // For new games the SenatePanel can derive it from the factions
  // list, but more reliably we just remember which proposals the
  // caller has voted on or owns. Simplest: pull /me to learn faction
  // id once, since SenatePanel already has access to /factions.
  // Track it once and reuse.

  // Order proposals: VOTING first (act now), then DEBATING, then
  // resolved. Within each group, soonest-closing first.
  const sortedProposals = useMemo(() => {
    const rank = (p: SenateProposal): number => {
      if (p.status === 'voting')   return 0;
      if (p.status === 'debating') return 1;
      return 2;
    };
    return [...proposals].sort((a, b) => {
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return a.vote_closes_at_tick - b.vote_closes_at_tick;
    });
  }, [proposals]);

  /** The buckets the tab renders, mockup order. ('voting' bills are no
   *  longer bucketed separately — the blocking-coalition section was the
   *  only consumer of that list; the ballot itself renders them from
   *  sortedProposals.) */
  const floorBills = useMemo(
    () => sortedProposals.filter(p => p.status === 'debating'),
    [sortedProposals],
  );
  // Only so the floor's empty state can tell "the chamber has nothing"
  // apart from "the chamber's bill is at a ballot, further up the tab".
  const votingBills = useMemo(
    () => sortedProposals.filter(p => p.status === 'voting'),
    [sortedProposals],
  );
  /** The chancellor election's fixed length (server-sent; 48 = two days
   *  at an hour a tick). */
  const chancellorTicks = session?.chancellor_vote_ticks ?? 48;
  const resolvedBills = useMemo(
    () => sortedProposals.filter(
      p => p.status === 'passed' || p.status === 'failed' || p.status === 'withdrawn',
    ),
    [sortedProposals],
  );
  return (
    <div>
      {/* Whose floor it is comes FIRST — above even the votable bills.
          Every other control on this tab is conditioned on it: whether
          the propose form is live, how long the current agenda-setter
          has, and who is in the room to make quorum. */}
      <SessionCard
        session={session}
        factions={factions}
        myFactionId={myFactionId}
        tickMs={tickMs}
      />
      {/* What this chamber has already DONE, directly under who is
          running it. Sits above the bill list because a law in force is
          affecting your economy right now, while a bill is only a
          proposal — and because the composer above it is where you'd go
          to counter one. Renders nothing when nothing is in force. */}
      <LawsCard
        laws={laws}
        tickMs={tickMs}
        // Chairman only, matching the compose drawer: filing a bill is the
        // gavel's privilege, and a REPEAL button that opens a form the
        // player doesn't have would be the same "draft it then eat a 403"
        // trap the drawer itself was hidden to avoid.
        onRepeal={session?.is_chairman === true ? (law) => {
          // Prefill the whole bill. A repeal is a formality — the decision
          // was "this law must go", not "let me write a title".
          const name = law.law_name ?? law.label;
          setKind('repeal_law');
          setRepealTargetId(law.proposal_id ?? '');
          setRepealTargetName(name);
          setTitle(t('senate.repeal.title', { name }).slice(0, 80));
          setSummary(
            (`${t('senate.repeal.summary', { title: law.proposal_title ?? name })} `
              + (law.effect_text ? t('senate.repeal.means', { effect: law.effect_text }) : '')).trim().slice(0, 500),
          );
          setError(null);
          // The drawer is a <details>; open it and bring it into view, or
          // the prefilled bill sits collapsed and the click looks inert.
          const el = document.getElementById('sp-compose') as HTMLDetailsElement | null;
          if (el) { el.open = true; el.scrollIntoView({ block: 'nearest' }); }
        } : undefined}
      />
      {/* ORDER IS THE POINT. A bill you can still vote on outranks the
          standings, the compose form and the integration settings — it is
          the only thing here with a deadline. Discord moves to the foot of
          the tab for the same reason: it is configuration, not play. */}
      <ActionableBills
        proposals={sortedProposals}
        currentTick={currentTick}
        factionsById={factionsById}
        chamber={chamberWeight}
        myFactionId={myFactionId}
        onVote={(id, v) => { void castVote(id, v); }}
        onWithdraw={(id) => { void withdraw(id); }}
        busy={voting}
        tickMs={tickMs}
        reparationsPer={reparationsPer}
        sliders={sliders}
      />
      {error && <div className="mp-error" style={{ marginBottom: 10 }}>{error}</div>}

      {/* THE FLOOR. There is no debate phase any more (a bill opens
          straight into voting, and votes live above in "Needs your vote"),
          so this only lists bills filed before that change that are still
          in debate, and otherwise says plainly when nothing is open. */}
      {(floorBills.length > 0 || votingBills.length === 0) && (
        <section className="sp-sect">
          <div className="sp-sect__h"><span className="sp-lbl">{t('senate.floor')}</span></div>
          {floorBills.length === 0 && (
            <div className="sp-empty">
              {session?.is_chairman === true
                ? t('senate.floor.none.chair')
                : t('senate.floor.none')}
            </div>
          )}
          {floorBills.map((p) => renderFloorBill(p))}
        </section>
      )}

      {/* The "blocking coalition" section was removed. It predated
          quorum and was blind to it: a nay vote increments `cast`, so on
          a bill that leads the tally but is short of quorum — one that
          dies on its own — it told you to go recruit nay votes and would
          carry the bill OVER the quorum line, converting a certain
          failure into a pass. Advice that loses you the vote is worse
          than no advice. The vote bar and the split chamber already
          carry the state. */}

      {/* No seat, no weight. An eliminated empire was shown "Your vote
          weight ★1" beside a chamber that (correctly) no longer seated it
          (QA battle test). Revival restores both. */}
      {factions.find(f => f.id === myFactionId)?.status === 'eliminated' ? (
        <div style={{
          border: '1px solid var(--mp-border)', borderRadius: 5,
          padding: 11, marginBottom: 14, marginTop: 14,
          fontSize: 10.5, color: 'var(--mp-fg-dim)', lineHeight: 1.55,
        }}>
          {t('senate.noSeat')}
        </div>
      ) : <WeightCard detail={weight} />}
      <Chamber
        factions={factions}
        myFactionId={myFactionId}
        ballots={floorBallots}
        // A chancellor election has no quorum: don't quote one over it.
        quorum={floorBill?.kind === 'chancellor_vote' ? null : (session?.quorum ?? null)}
        billTitle={floorBill?.title ?? null}
        otherOpen={Math.max(0, openVoteCount - 1)}
      />

      {/* Chairman-only, and hidden rather than disabled: a form every
          non-chairman can open but never submit is an invitation to
          draft a bill and lose it to a 403. The SessionCard above
          already tells everyone else whose floor it is and where they
          sit in the rotation. Strict === true: while the session is
          still loading nobody sees the drawer, and the server's
          not_chairman gate stays the real authority. */}
      {session?.is_chairman === true && (
      <details className="sp-disc" id="sp-compose">
      <summary>{t('senate.compose.summary')}</summary>
      <div className="sp-disc__body">
      <form onSubmit={propose}>
        <label className="mp-label">{t('senate.compose.kind')}</label>
        <select
          className="mp-select"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as BillKind;
            setKind(next);
            setTargetFactionId('');     // reset so a stale target doesn't carry across kinds
            // Same reasoning for the repeal target: switching kinds by
            // hand must not leave a bill aimed at a law it no longer is.
            if (next !== 'repeal_law') { setRepealTargetId(''); setRepealTargetName(''); }
          }}
        >
          {(Object.keys(BILL_KIND_LABELS) as BillKind[]).map(k => {
            // One chancellor election per term, never two open: the server
            // says so (chancellor_available) and refuses otherwise, AFTER
            // the "your only attempt" confirm -- so say it here instead.
            const noChancellor = k === 'chancellor_vote' && session?.chancellor_available === false;
            return (
              <option key={k} value={k} disabled={noChancellor}>
                {t(BILL_KIND_LABELS[k])}{noChancellor ? t('senate.compose.onePerTerm') : ''}
              </option>
            );
          })}
        </select>

        {kind === 'slider_law' && (
          <>
            <label className="mp-label">{t('senate.compose.what')}</label>
            <select
              className="mp-select"
              value={sliderId}
              onChange={(e) => {
                setSliderId(e.target.value);
                const s = sliders.find((x) => x.id === e.target.value);
                if (s) setTarget(s.effective_value);
              }}
            >
              {sliders.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            {selectedSlider && (
              <>
                <div style={{ fontSize: 11, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
                  {selectedSlider.description}
                  {selectedSlider.current && !selectedSlider.current.at_default && (
                    <> <span style={{ color: '#ffcf70' }}>
                      {t('senate.compose.rightNow', { effect: selectedSlider.current.effect })}
                    </span></>
                  )}
                </div>

                {/* WAS a bare number box labelled "Target value (range
                    0.5–1.5; default 1)". Nobody proposing a bill thinks
                    in multipliers — they think "ships should be cheaper"
                    — and the box told you neither which direction was
                    which nor what any number would do. A drag with a
                    live sentence under it keeps every value reachable
                    while making the consequence impossible to miss. */}
                <label className="mp-label">{t('senate.compose.howFar')}</label>
                <input
                  className="mp-range"
                  type="range"
                  step={selectedSlider.step || 'any'}
                  min={selectedSlider.min}
                  max={selectedSlider.max}
                  value={target}
                  style={{ width: '100%' }}
                  onChange={(e) => setTarget(parseFloat(e.target.value))}
                />
                {(() => {
                  const said = lawPhrase(sliders, selectedSlider.id, target);
                  const nothing = said?.at_default ?? (target === selectedSlider.default);
                  return (
                    <div style={{
                      border: '1px solid var(--mp-border)', borderRadius: 4,
                      padding: '6px 8px', marginTop: 4,
                      background: nothing ? 'rgba(255,138,92,0.08)' : 'rgba(110,231,183,0.07)',
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: nothing ? '#ff8a5c' : '#6ee7b7' }}>
                        {said?.name ?? fmtNum(target)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--mp-fg)' }}>
                        {said?.effect ?? t('senate.compose.setsValue', { v: fmtNum(target) })}
                      </div>
                      {/* A bill at the default passes and does nothing.
                          Worth saying out loud BEFORE someone spends a
                          whole term's floor time on it. */}
                      {nothing && (
                        <div style={{ fontSize: 10, color: '#ff8a5c', marginTop: 2 }}>
                          {t('senate.compose.dragBar')}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Who the law binds. "Everyone" is the default and the
                    historical behaviour of every slider law. A named
                    faction makes it apply to them ALONE, overriding the
                    general law for them and leaving everyone else on it.
                    Match-wide knobs (per_faction false) hide this
                    entirely rather than offering a choice the server
                    will reject. */}
                {selectedSlider.per_faction !== false && (
                  <>
                    <label className="mp-label">{t('senate.compose.who')}</label>
                    <select
                      className="mp-select"
                      value={sliderTargetId}
                      onChange={(e) => setSliderTargetId(e.target.value)}
                    >
                      <option value="">{t('senate.compose.everyone')}</option>
                      {factions.map(f => (
                        <option key={f.id} value={f.id}>
                          {t('senate.compose.only', { name: f.name })}{f.id === myFactionId ? ` ${t('senate.you')}` : ''}
                        </option>
                      ))}
                    </select>
                    <div style={{ fontSize: 11, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
                      {sliderTargetId
                        ? t('senate.compose.onlyFeel', { name: factions.find(f => f.id === sliderTargetId)?.name ?? t('senate.compose.they') })
                          + (sliderTargetId === myFactionId
                            ? ` ${t('senate.compose.onlySelf')}`
                            : '')
                        : t('senate.compose.everyoneFeels')}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* REPEAL: no picker, because the target came from the law itself.
            Confirm what is being struck down and say plainly that this
            takes a vote like anything else — a repeal is not a veto. */}
        {kind === 'repeal_law' && (
          <div style={{
            border: '1px solid rgba(255,94,94,0.4)', borderRadius: 4,
            padding: '7px 9px', marginBottom: 8,
            background: 'rgba(255,94,94,0.06)', fontSize: 11, lineHeight: 1.5,
          }}>
            {repealTargetId ? (
              <>
                <div style={{ color: '#ff8080', fontWeight: 700 }}>
                  {t('senate.repeal.striking', { name: repealTargetName || t('senate.repeal.aStanding') })}
                </div>
                <div style={{ color: 'var(--mp-fg-dim)' }}>
                  {t('senate.repeal.ends')}
                </div>
              </>
            ) : (
              <div style={{ color: '#ff8080' }}>
                {t('senate.repeal.pickPre')} <b>{t('senate.laws.repeal')}</b> {t('senate.repeal.pickPost')}
              </div>
            )}
          </div>
        )}

        {NEEDS_TARGET[kind] && (
          <>
            <label className="mp-label">
              {kind === 'chancellor_vote' ? t('senate.compose.candidate') : t('senate.compose.target')}
            </label>
            <select
              className="mp-select"
              value={targetFactionId}
              onChange={(e) => setTargetFactionId(e.target.value)}
            >
              <option value="">{t('senate.compose.choose')}</option>
              {factions
                // Sanctions can't target self; chancellor_vote can. Filter
                // accordingly so an invalid choice isn't even presented.
                .filter(f => kind === 'chancellor_vote' || f.id !== myFactionId)
                .map(f => (
                  <option key={f.id} value={f.id}>
                    {f.name}{f.id === myFactionId ? ` ${t('senate.you')}` : ''}
                  </option>
                ))}
            </select>
            {kind === 'chancellor_vote' && (
              <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4, fontStyle: 'italic' }}>
                {t('senate.compose.oneAttempt')}
              </div>
            )}
            {kind === 'reparations' && (
              <>
                <label className="mp-label">{t('senate.compose.repAmount')}</label>
                <input
                  className="mp-input"
                  type="number"
                  inputMode="numeric"
                  min={reparationsRange.min}
                  max={reparationsRange.max}
                  step={1}
                  value={repAmount}
                  placeholder={String(reparationsPer ?? 200)}
                  onChange={(e) => setRepAmount(e.target.value)}
                />
                <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4, fontStyle: 'italic' }}>
                  {(() => {
                    // Say what the number adds up to BEFORE the bill is
                    // filed: recipients are every other living faction.
                    const per = repAmount.trim() === '' ? (reparationsPer ?? 0) : Number(repAmount);
                    const others = factions.filter(f => f.status === 'active' && f.id !== targetFactionId).length;
                    if (!targetFactionId || !Number.isFinite(per) || per <= 0 || others <= 0) {
                      return t('senate.compose.repHelpNoTarget', { min: fmtNum(reparationsRange.min), max: fmtNum(reparationsRange.max) });
                    }
                    return t('senate.compose.repHelp', {
                      players: tn('senate.fx.players', others), amount: fmtNum(per), total: fmtNum(per * others),
                    });
                  })()}
                </div>
              </>
            )}
          </>
        )}
        <label className="mp-label">{t('senate.compose.title')}</label>
        <input
          className="mp-input"
          type="text"
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="mp-label">{t('senate.compose.summaryLbl')}</label>
        <textarea
          className="mp-textarea"
          maxLength={500}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />

        {/* No debate phase: the vote opens the moment the bill is filed.
            The chancellor election's length is fixed by the server. */}
        {kind === 'chancellor_vote' ? (
          <div style={{ fontSize: 11, color: 'var(--mp-fg-dim)', marginTop: 8, lineHeight: 1.45 }}>
            {t('senate.compose.chancellorPre')} <b>{tn('senate.ticks', chancellorTicks)}</b>{realSuffix(chancellorTicks, tickMs)} {t('senate.compose.chancellorPost')}
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <label className="mp-label">{t('senate.compose.lasts', { min: minVote, max: voteMax })}</label>
            <input
              className="mp-input"
              type="number"
              inputMode="numeric"
              min={minVote}
              max={voteMax}
              value={voteTicks}
              onChange={(e) => setVoteTicks(Math.max(minVote, parseInt(e.target.value, 10) || minVote))}
            />
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
          {t('senate.compose.closesAt', { n: currentTick + (kind === 'chancellor_vote' ? chancellorTicks : voteTicks) })}
          {session?.term && currentTick + (kind === 'chancellor_vote' ? chancellorTicks : voteTicks) > session.term.end_tick
            && ` ${t('senate.compose.afterTerm')}`}
        </div>

        {proposeLock && (
          <div style={{
            marginTop: 10, fontSize: 11, lineHeight: 1.45, color: '#ffb84d',
            border: '1px solid rgba(255, 184, 77, 0.4)', borderRadius: 4,
            background: 'rgba(255, 184, 77, 0.06)', padding: '8px 10px',
          }}>
            {t('senate.lock.pre')} <b>{proposeLock.tier}</b>.
            {kind === 'chancellor_vote'
              ? ` ${t('senate.lock.chancellor')}`
              : ` ${t('senate.lock.others')}`}
          </div>
        )}
        {/* The gavel gate is separate from the research gate and reported
            separately: "you haven't researched this" and "it isn't your
            turn" are different problems with different fixes, and
            collapsing them into one disabled button would tell a player
            to go do research when all they need to do is wait. */}
        {session && !session.can_propose && session.cannot_propose_reason && (
          <div style={{
            marginTop: 10, fontSize: 11, lineHeight: 1.45, color: 'var(--mp-fg-dim)',
            border: '1px solid var(--mp-border)', borderRadius: 4,
            background: 'rgba(255,255,255,0.03)', padding: '8px 10px',
          }}>
            🔨 {session.cannot_propose_reason}
          </div>
        )}
        <button
          className="mp-submit"
          type="submit"
          style={{ marginTop: 10 }}
          disabled={busy || !!proposeLock || (!!session && !session.can_propose)}
          title={proposeLock ? `${proposeLock.label} — ${t('senate.lock.text', { tier: proposeLock.tier })}`
               : session?.cannot_propose_reason ?? undefined}
        >
          {busy ? t('senate.compose.submitting')
            : proposeLock ? t('senate.compose.locked')
            // The composer is chairman-only, so "not your floor" was never
            // the reason: it is a spent term budget or a full chamber.
            : (session && !session.can_propose)
              ? (session.floor_busy ? t('senate.compose.full')
                : session.bills_left_this_term === 0 ? t('senate.compose.noBills')
                : t('senate.compose.cant'))
            : t('senate.compose.submit')}
        </button>
      </form>
      </div>
      </details>
      )}

      {/* Settled business, one line each. It is a record, not a decision,
          and it grows without bound. */}
      <details className="sp-disc is-quiet">
        <summary>{t('senate.resolved', { n: resolvedBills.length })}</summary>
        <div className="sp-disc__body">
          {resolvedBills.length === 0 && (
            <div className="sp-empty">{t('senate.resolved.none')}</div>
          )}
          {resolvedBills.map((p) => {
            const yea = p.totals?.yea?.weight ?? 0;
            const nay = p.totals?.nay?.weight ?? 0;
            const verdict = p.status === 'passed'
              ? t('senate.verdict.passed', { yea, nay })
              : p.status === 'failed'
                ? t('senate.verdict.failed', { yea, nay })
                : t('senate.status.withdrawn');
            // "Who voted no on my bill" is a question a player literally
            // typed into chat. The ballots are public record — put them
            // one click away instead of zero clicks from nowhere.
            const ballots = p.ballots ?? [];
            const votedIds = new Set(ballots.map(b => b.faction_id));
            const absent = p.status === 'withdrawn' ? [] : factions.filter(f => !votedIds.has(f.id));
            return (
              <details key={p.id} className="sp-roll" >
                <summary className="sp-histrow" title={p.summary || undefined}>
                  <span className="sp-histrow__t">{p.title}</span>
                  <span className={`sp-histrow__r is-${p.status}`}>
                    {verdict}{p.resolved_at_tick != null ? ` · T+${p.resolved_at_tick}` : ''}
                  </span>
                </summary>
                {p.status !== 'withdrawn' && (
                  <div className="sp-roll__body">
                    {ballots.map(b => {
                      const f = factionsById.get(b.faction_id);
                      return (
                        <span key={b.faction_id} className={`sp-roll__chip is-${b.vote}`}>
                          <span className="sp-roll__dot" style={{ background: f?.color ?? '#8aa0b4' }} />
                          {f?.name ?? '???'} · {voteWord(b.vote)} ({b.weight})
                        </span>
                      );
                    })}
                    {absent.map(f => (
                      <span key={f.id} className="sp-roll__chip is-absent">
                        <span className="sp-roll__dot" style={{ background: f.color }} />
                        {f.name} · {t('senate.neverVoted')}
                      </span>
                    ))}
                  </div>
                )}
              </details>
            );
          })}
          {/* A second laws-in-force list used to sit here, phrased as
              "Ship Build Cost Multiplier 0.5". LawsCard at the top of
              the tab is the one place that answers this now — two lists
              of the same laws in two different vocabularies is exactly
              how a player ends up trusting neither. */}
        </div>
      </details>

      {/* Integration settings live at the foot of the tab: configuration,
          not play. */}
      <div className="sp-foot">
        <DiscordLink />
      </div>
    </div>
  );

  /** One bill in debate. Everything the old flat list showed except the
   *  ballot row — a debating bill can take early votes, and those still
   *  work through the buttons that appear when it reaches the floor. */
  function renderFloorBill(p: SenateProposal) {
    const proposer = p.proposer_faction_id ? factionsById.get(p.proposer_faction_id) : null;
        const inVoting = p.status === 'voting';
        const ticksUntilOpen  = Math.max(0, p.vote_opens_at_tick  - currentTick);
        const ticksUntilClose = Math.max(0, p.vote_closes_at_tick - currentTick);
        const my = p.caller_vote;

        return (
          <div key={p.id} className="mp-proposal">
            <div className="ptitle">{p.title}</div>
            <div className="pmeta" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {proposer && (
                <>
                  <span className="mp-swatch" style={{ background: proposer.color }} />
                  <span>{proposer.name}</span>
                  <span>·</span>
                </>
              )}
              <span style={{ color: STATUS_COLORS[p.status], fontWeight: 600 }}>
                {t(STATUS_LABEL[p.status])}
              </span>
              {p.status === 'debating' && (<><span>·</span><span>{t('senate.floorBill.opens', { n: ticksUntilOpen })}</span></>)}
              {p.status === 'voting' && (
                <><span>·</span><span style={{ color: STATUS_COLORS.voting }}>{t('senate.floorBill.closes', { n: ticksUntilClose })}</span></>
              )}
              {(p.status === 'passed' || p.status === 'failed') && p.resolved_at_tick != null && (
                <><span>·</span><span>{t('senate.floorBill.atTick', { n: p.resolved_at_tick })}</span></>
              )}
            </div>
            <div className="psummary">{p.summary}</div>
            <ProposalEffectLine
              proposal={p}
              factionsById={factionsById}
              sliders={sliders}
              reparationsPer={reparationsPer}
            />
            {/* New bill-kind tag — small chip showing what kind of bill
                this is, since slider-law and a chancellor-vote look very
                different in consequence. */}
            <div style={{
              display: 'inline-block', fontSize: 9, color: '#b8c8d6',
              border: '1px solid #2a3d50', borderRadius: 8,
              padding: '1px 6px', marginTop: 4, letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              {(BILL_KIND_LABELS[p.kind as BillKind] ? t(BILL_KIND_LABELS[p.kind as BillKind]) : p.kind).split(' (')[0]}
            </div>

            <VoteBar totals={p.totals} quorum={p.quorum} />

            {inVoting && (
              <div className="mp-vote-row">
                <button
                  className={`mp-vote-btn yea ${my === 'yea' ? 'mine' : ''}`}
                  onClick={() => castVote(p.id, 'yea')}
                >{t('senate.yea')}</button>
                <button
                  className={`mp-vote-btn nay ${my === 'nay' ? 'mine' : ''}`}
                  onClick={() => castVote(p.id, 'nay')}
                >{t('senate.nay')}</button>
                <button
                  className={`mp-vote-btn abstain ${my === 'abstain' ? 'mine' : ''}`}
                  onClick={() => castVote(p.id, 'abstain')}
                >{t('senate.abstain')}</button>
              </div>
            )}
            {p.status === 'debating' && (
              <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4, fontStyle: 'italic' }}>
                {t('senate.floorBill.opensIn', { time: ticksReal(ticksUntilOpen, tickMs) })}
                {my && <> {t('senate.floorBill.early')} <strong>{voteWord(my)}</strong></>}
              </div>
            )}
            {/* Withdraw is proposer-only + debating-only (server-side gate). Mirror
                that here so the button doesn't show up where it can't do anything. */}
            {p.status === 'debating' && myFactionId && p.proposer_faction_id === myFactionId && (
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={() => { void withdraw(p.id); }}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--mp-border)',
                    color: 'var(--mp-fg-dim)',
                    padding: '4px 10px',
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                    borderRadius: 2,
                  }}
                  title={t('senate.floorBill.withdrawTip')}
                >
                  {t('senate.floorBill.withdraw')}
                </button>
              </div>
            )}
          </div>
        );
  }
}

// Tidy number formatter — 1.0 → "1", 1.25 → "1.25", 0.8 → "0.8".
function fmtNum(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * One-line summary of what a bill DOES, switching on kind. Sits under the
 * proposal's freeform summary so the player can see the mechanical
 * effect at a glance — "Embargoes Mars Confederacy" — without having to
 * read the proposer's prose to understand the consequences.
 */
function ProposalEffectLine({
  proposal: p,
  factionsById,
  sliders,
  reparationsPer,
}: {
  proposal: SenateProposal;
  factionsById: Map<string, Faction>;
  /** Catalog, for the server's plain wording of a slider law. */
  sliders: SenateSlider[];
  /** Server-sent per-faction reparations amount; null until /sliders
   *  answers. Null renders the old vague line rather than a wrong number. */
  reparationsPer?: number | null;
}) {
  useI18n();
  const k = p.kind as BillKind;
  const targetId = p.payload?.target_faction_id || p.payload?.candidate_faction_id;
  const targetName = targetId ? (factionsById.get(targetId)?.name ?? targetId) : null;
  const wrap = (s: React.ReactNode) => (
    <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
      {s}
      {p.effect_until_tick != null && p.status === 'passed' && (
        <> · {t('senate.fx.activeUntil', { n: p.effect_until_tick })}</>
      )}
    </div>
  );

  if (k === 'slider_law' && p.payload?.slider_id) {
    // This line used to print the DATABASE COLUMN on the card people cast
    // votes from — "Sets ship_build_cost_multiplier to 0.5 for every
    // faction". Now it says what the law does, in the server's words.
    const said = lawPhrase(sliders, p.payload.slider_id, p.payload.target_value);
    const def = sliders.find(s => s.id === p.payload?.slider_id);
    return wrap(<>
      <strong style={{ color: 'var(--mp-fg)' }}>{said?.name ?? def?.label ?? t('senate.fx.ruleChange')}</strong>
      {' — '}
      {said?.effect ?? t('senate.fx.ruleChanges', { label: def?.label ?? t('senate.fx.aRule') })}
      {targetName
        ? <>{' '}{rich('senate.fx.hitsAlone', { name: <strong>{targetName}</strong> })}</>
        : <>{' '}{rich('senate.fx.appliesAll', { everyone: <strong>{t('senate.fx.everyoneWord')}</strong> })}</>}
    </>);
  }
  // REPEAL aims at a law, so it has no target FACTION to describe — its
  // payload carries the target bill's own title and effect, captured when
  // the repeal was filed so the card reads correctly even after the law
  // it names has gone.
  if (k === 'repeal_law') {
    const targetTitle = p.payload?.target_title as string | undefined;
    const targetEffect = p.payload?.target_effect as string | undefined;
    return wrap(<>
      <strong style={{ color: 'var(--mp-fg)' }}>{t('senate.fx.repeal')}</strong>
      {rich('senate.fx.repealEnds', { title: <strong>{targetTitle ?? t('senate.repeal.aStanding')}</strong> })}
      {targetEffect ? <> {t('senate.fx.currently', { effect: targetEffect })}</> : null}
    </>);
  }
  if (!targetName) return null;
  const who = <strong>{targetName}</strong>;
  if (k === 'trade_embargo')       return wrap(<>{rich('senate.fx.embargo', { name: who })}</>);
  if (k === 'war_authorization')   return wrap(<>{rich('senate.fx.war', { name: who })}</>);
  if (k === 'production_sanction') return wrap(<>{rich('senate.fx.sanction', { name: who })}</>);
  if (k === 'reparations') {
    // A BILL THAT MOVES MONEY MUST SAY HOW MUCH. This read "hands
    // credits to every other player" -- no figure anywhere, while the
    // server has always paid a fixed REPARATIONS_PER_FACTION per
    // recipient. Voters were being asked to approve a transfer of
    // unstated size, and the proposer could not know what they were
    // asking for either.
    //
    // The cap is stated too, because it bites: the payout is limited to
    // the target's actual credits and then pro-rated evenly, so a broke
    // target pays far less than the headline. Promising 200 and
    // delivering 40 without warning is the kind of thing players read as
    // a bug.
    // p.quorum.eligible is the server's own count of living factions --
    // the same number the quorum line quotes. Reusing it means the card
    // cannot disagree with itself about how many players there are.
    const others = Math.max(0, (p.quorum?.eligible ?? 0) - 1);
    // The chairman names the figure when filing; a bill filed before that
    // was possible carries none and paid the server default.
    const billPer = typeof p.payload?.amount_per_faction === 'number' ? p.payload.amount_per_faction : reparationsPer;
    if (billPer == null || others === 0) {
      return wrap(<>{rich('senate.fx.reparationsVague', { name: who })}</>);
    }
    return wrap(<>
      {rich('senate.fx.reparations', {
        name: who,
        amount: <strong>{t('senate.fx.credits', { n: fmtNum(billPer) })}</strong>,
        players: tn('senate.fx.players', others),
        total: fmtNum(billPer * others),
      })}
    </>);
  }
  if (k === 'chancellor_vote')     return wrap(<>{rich('senate.fx.chancellor', { name: who })}</>);
  return null;
}

/**
 * The server's wording for one slider value.
 *
 * A lookup, not a formatter. Every phrase for every reachable value ships
 * with the catalog precisely so the browser owns no phrasing rules — the
 * words for a law live in worker/senate.js and nowhere else. Returns null
 * when the value isn't in the table (an older server, or a value from
 * outside the current range), and callers fall back to the topic name.
 */
function lawPhrase(
  sliders: SenateSlider[], sliderId: string, value: unknown,
): LawPhrase | null {
  const def = sliders.find(s => s.id === sliderId);
  const v = Number(value);
  if (!def?.phrases || !Number.isFinite(v)) return null;
  // Keys are written by the server at 3dp; match that rounding exactly or
  // a 0.05-step value arrives as 0.7000000000000001 and never hits.
  return def.phrases[String(Math.round(v * 1000) / 1000)] ?? null;
}

// Vote weight bar. Source of truth for ratification is WEIGHT (1 per
// faction + 1 per system controlled), not headcount. Count is shown
// alongside so it's clear how many factions a weight represents —
// without it, "Yea 18" reads as eighteen voters.
function VoteBar({ totals, quorum }: {
  totals: SenateProposal['totals'];
  quorum?: SenateProposal['quorum'];
}) {
  useI18n();
  const yeaW     = totals?.yea?.weight     ?? 0;
  const nayW     = totals?.nay?.weight     ?? 0;
  const abstainW = totals?.abstain?.weight ?? 0;
  const total = yeaW + nayW + abstainW;

  // Quorum has to be visible DURING the vote. A bill that looks like it
  // is winning and then dies for want of a room reads as a bug unless
  // the shortfall was on screen the whole time.
  const quorumLine = quorum ? (
    <div style={{
      fontSize: 10, marginTop: 4,
      color: quorum.met ? '#6ee7b7' : '#ffb84d',
    }}>
      {quorum.met
        ? t('senate.quorum.met', { cast: quorum.cast, required: quorum.required })
        : t('senate.quorum.needs', { cast: quorum.cast, required: quorum.required })}
      <span style={{ color: 'var(--mp-fg-dim)' }}>
        {' '}{t('senate.quorum.majority', { n: quorum.eligible })}
      </span>
    </div>
  ) : null;

  if (total === 0) {
    return (
      <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
        {t('senate.noVotes')}
        {quorumLine}
      </div>
    );
  }

  const pctY = (yeaW     / total) * 100;
  const pctN = (nayW     / total) * 100;
  const pctA = (abstainW / total) * 100;

  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          display: 'flex',
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ width: `${pctY}%`, background: '#6ee7b7' }} />
        <div style={{ width: `${pctN}%`, background: '#ff5e5e' }} />
        <div style={{ width: `${pctA}%`, background: '#8a9fb3' }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--mp-fg-dim)', marginTop: 4 }}>
        {`${t('senate.yea')} ${yeaW} (${totals.yea.count}) · ${t('senate.nay')} ${nayW} (${totals.nay.count}) · ${t('senate.abstain')} ${abstainW} (${totals.abstain.count})`}
      </div>
      {quorumLine}
    </div>
  );
}

/** Live senate weight for a faction. `senate_weight` is vestigial — the
 *  chamber recomputes at cast time and never writes it back — so prefer
 *  the computed value the factions endpoint sends. */
function voteWeightOf(f: Faction): number {
  return (f as unknown as { vote_weight?: number }).vote_weight
    ?? f.senate_weight ?? 1;
}

/**
 * Bills that still need something from YOU, hoisted above everything else.
 *
 * A chancellor bill is a win condition with no quorum: it passes on more
 * yea than nay among ballots actually cast. Burying it under the compose
 * form is how a table sleeps through the end of its own game — which is
 * exactly how The Friendly Zone ended, 7-2, with five factions never
 * voting.
 */
function ActionableBills({
  proposals, currentTick, factionsById, chamber, myFactionId, onVote, busy,
  tickMs, sliders, reparationsPer, onWithdraw,
}: {
  onWithdraw?: (id: string) => void;
  proposals: SenateProposal[];
  currentTick: number;
  factionsById: Map<string, Faction>;
  chamber: number;
  myFactionId: string | null;
  onVote: (id: string, vote: 'yea' | 'nay' | 'abstain') => void;
  /** Threaded down to the effect line so a reparations bill can state
   *  its actual figure. Server-sent; see SenatePanel state. */
  reparationsPer?: number | null;
  busy: string | null;
  tickMs: number | null;
  /** Passed through to the vote card so a bill at ballot can state its
   *  own effect, the way it does while it is still in debate. */
  sliders: SenateSlider[];
}) {
  useI18n();
  const open = proposals.filter(p => p.status === 'voting');
  if (open.length === 0) return null;
  // The deadline lives in the section header, where the mockup put it —
  // red, because it is the only clock on the tab that runs out.
  const soonest = Math.min(...open.map(p => Math.max(0, p.vote_closes_at_tick - currentTick)));
  return (
    <section className="sp-sect">
      <div className="sp-sect__h">
        <span className="sp-lbl">{t('senate.needsVote')}</span>
        <span className="sp-lbl" style={{ color: '#ff6b6b' }}>
          {t('senate.closesIn', { time: ticksReal(soonest, tickMs) })}
        </span>
      </div>
      {open.map(p => (
        <VoteCard
          key={p.id}
          p={p}
          factionsById={factionsById}
          chamber={chamber}
          onVote={onVote}
          busy={busy}
          sliders={sliders}
          reparationsPer={reparationsPer}
          myFactionId={myFactionId}
          onWithdraw={onWithdraw}
        />
      ))}
    </section>
  );
}

/**
 * A bill you can still act on.
 *
 * The vote buttons live ON the card. A chancellor bill is a win condition
 * with no quorum — it passes on more yea than nay among ballots actually
 * cast — so the distance between reading it and voting on it should be
 * zero. The tally is a proportional bar rather than three numbers because
 * "is this close?" is the question, and a bar answers it without
 * arithmetic.
 */
function VoteCard({
  p, factionsById, chamber, onVote, busy, sliders, reparationsPer,
  myFactionId = null, onWithdraw,
}: {
  myFactionId?: string | null;
  onWithdraw?: (id: string) => void;
  p: SenateProposal;
  factionsById: Map<string, Faction>;
  chamber: number;
  onVote: (id: string, vote: 'yea' | 'nay' | 'abstain') => void;
  busy: string | null;
  /** Catalog, so this card can say what the bill DOES — see below. */
  sliders: SenateSlider[];
  reparationsPer?: number | null;
}) {
  useI18n();
  const proposer = p.proposer_faction_id ? factionsById.get(p.proposer_faction_id) : null;
  const yea = p.totals?.yea?.weight ?? 0;
  const nay = p.totals?.nay?.weight ?? 0;
  const abs = p.totals?.abstain?.weight ?? 0;
  const cast = yea + nay + abs;
  const uncast = Math.max(0, chamber - cast);
  const my = p.caller_vote;
  const isChancellor = p.kind === 'chancellor_vote';
  // Widths measure share of the WHOLE chamber, not of votes cast, so the
  // uncast block stays visible. A bar that renormalises as people vote
  // hides the fact that most of the senate hasn't shown up.
  const denom = Math.max(1, chamber);
  const pct = (n: number) => (n / denom) * 100;
  return (
    <div className={`sp-vc${isChancellor ? ' is-chancellor' : ''}`}>
      <div className="sp-vc__t">
        <span className="sp-vc__n">{p.title}</span>
        <span className="sp-vc__s">{t('senate.vc.voting')}</span>
      </div>
      <div className="sp-vc__m">
        {isChancellor
          ? <>{rich('senate.vc.chancellor', { name: proposer?.name ?? t('comms.unknown'), note: <b>{t('senate.vc.theyWin')}</b> })}</>
          : <>{tk(`senate.kind.${p.kind}`, p.kind.replace(/_/g, ' '))}{proposer ? ` · ${proposer.name}` : ''}</>}
      </div>
      {/* WHAT THE BILL ACTUALLY DOES (clownking, 2026-08-14: "I saw it in
          discord, so I know it's for cheaper fleets again, but I don't
          see that info anywhere in the senate tab").
          A bill carries its summary and its plain-worded effect the whole
          time it sits on the floor — and then ActionableBills hoists it
          up here the moment it reaches a ballot, into a card that showed
          the title, the proposer and the tally and nothing about the
          consequences. The detail vanished at precisely the moment a
          player was being asked to vote on it. Same two lines the floor
          card has always rendered. */}
      {p.summary && <div className="sp-vc__sum">{p.summary}</div>}
      {/* Not for a chancellor vote: the meta line directly above already
          says "if it passes, they win", and the effect line would say it
          again in different words. */}
      {!isChancellor && (
        <ProposalEffectLine
          proposal={p}
          factionsById={factionsById}
          sliders={sliders}
          reparationsPer={reparationsPer}
        />
      )}
      <div className="sp-tally">
        {yea > 0 && <div style={{ width: `${pct(yea)}%`, background: '#6ee7b7' }}>{t('senate.vc.yeaN', { n: yea })}</div>}
        {nay > 0 && <div style={{ width: `${pct(nay)}%`, background: '#ff6b6b' }}>{t('senate.vc.nayN', { n: nay })}</div>}
        {abs > 0 && <div style={{ width: `${pct(abs)}%`, background: '#8a9fb3' }}>{t('senate.vc.absN', { n: abs })}</div>}
        {uncast > 0 && <div className="none" style={{ width: `${pct(uncast)}%` }}>{t('senate.vc.uncast', { n: uncast })}</div>}
      </div>
      <div className="sp-tally__cap">{t('senate.vc.share', { n: chamber })}</div>
      {/* Turnout, not just the tally. With no quorum the bill is decided
          by whoever shows up, so the uncast share is the number that says
          whether you can still change the outcome. */}
      <div className="sp-turnout">
        <b>{t('senate.vc.turnout', { cast, chamber })}</b>{' '}
        {t('senate.vc.rule')}
        {' '}{yea > 0 ? t('senate.vc.blocks', { n: yea }) : t('senate.vc.nobodyYea')}
      </div>
      {/* QUORUM, for every bill but the chancellor's. This card was the
          chancellor's, which has none; since bills stopped spending time
          in debate (a47ef974) EVERY bill lands here straight away, and the
          floor card that used to show "Needs quorum" never renders for
          them -- so an ordinary bill at 1 yea read as winning and then
          died unheard. */}
      {!isChancellor && p.quorum && (
        <div
          className="sp-turnout"
          data-testid="vc-quorum"
          style={{ color: p.quorum.met ? '#6ee7b7' : '#ffb84d' }}
        >
          {p.quorum.met
            ? t('senate.quorum.met', { cast: p.quorum.cast, required: p.quorum.required })
            : t('senate.quorum.needsDies', { cast: p.quorum.cast, required: p.quorum.required })}
          {' '}{t('senate.quorum.majority', { n: p.quorum.eligible })}
        </div>
      )}
      <div className="sp-votebtns">
        <button
          className={`sp-vb sp-vb--yea${my === 'yea' ? ' is-cast' : ''}`}
          disabled={busy === p.id}
          onClick={() => onVote(p.id, 'yea')}
        >
          {t('senate.yea')}{my === 'yea' ? ' ✓' : ''}
        </button>
        <button
          className={`sp-vb sp-vb--nay${my === 'nay' ? ' is-cast' : ''}`}
          disabled={busy === p.id}
          onClick={() => onVote(p.id, 'nay')}
        >
          {t('senate.nay')}{my === 'nay' ? ' ✓' : ''}
        </button>
        <button
          className={`sp-vb sp-vb--abs${my === 'abstain' ? ' is-cast' : ''}`}
          disabled={busy === p.id}
          onClick={() => onVote(p.id, 'abstain')}
        >
          {t('senate.abstain')}{my === 'abstain' ? ' ✓' : ''}
        </button>
      </div>
      {/* WITHDRAW, the proposer's, until anyone else has voted -- the
          server's rule (senate.js handleWithdraw). It lived only on the
          debate card, which new bills never get, so it had vanished. */}
      {onWithdraw && myFactionId && p.proposer_faction_id === myFactionId
        && Array.isArray(p.ballots)
        && p.ballots.every(b => b.faction_id === myFactionId) && (
        <div style={{ marginTop: 6 }}>
          <button
            data-testid="vc-withdraw"
            onClick={() => onWithdraw(p.id)}
            disabled={busy === p.id}
            title={t('senate.vc.withdrawTip')}
            style={{
              background: 'transparent', border: '1px solid var(--mp-border)',
              color: 'var(--mp-fg-dim)', padding: '4px 10px', fontSize: 10,
              letterSpacing: '0.08em', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t('senate.vc.withdraw')}
          </button>
        </div>
      )}
    </div>
  );
}


/**
 * The chamber, drawn as seats.
 *
 * Vote weight is the chancellor win condition, and a column of numbers
 * doesn't show which pairings clear a majority. Seats do — a bloc is
 * visible as a bloc.
 */
function Chamber({
  factions, myFactionId, ballots, quorum, billTitle = null, otherOpen = 0,
}: {
  /** The bill the seats describe, and how many OTHER votes are open. */
  billTitle?: string | null;
  otherOpen?: number;
  factions: Faction[];
  myFactionId: string | null;
  /** How each faction voted on the bill currently on the floor, or null
   *  when nothing is being voted on. Direction, not just presence — the
   *  chamber seats a faction on the side it actually chose. */
  ballots: Map<string, 'yea' | 'nay' | 'abstain'> | null;
  /** Quorum bar for this game. Every living faction counts toward the
   *  denominator — an idle player keeps their seat, so there is no
   *  "present vs absent" distinction to draw here. Only elimination
   *  removes a seat, and eliminated factions are already filtered out. */
  quorum: { required: number; eligible: number } | null;
}) {
  useI18n();
  const seated = factions
    .filter(f => f.status !== 'eliminated')
    .map(f => ({ f, w: voteWeightOf(f) }))
    .sort((a, b) => b.w - a.w);
  const total = seated.reduce((n, x) => n + x.w, 0);
  if (total <= 0) return null;
  const initials = (name: string) =>
    name.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '??';
  const weightById = new Map(seated.map(({ f, w }) => [f.id, w]));

  // One seat per VOTE, bucketed by the direction its faction chose.
  //
  // With no bill on the floor there are no sides to take, so everything
  // collapses into a single neutral block — splitting an idle chamber
  // into three empty columns would invent a distinction that isn't
  // there. `always` keeps the not-voted group rendered even when empty,
  // because "nobody is missing" is itself worth seeing while a vote is
  // live; the yea/nay groups hide when empty rather than print a rail
  // of dashes.
  type Seat = { f: Faction; i: number; voted: boolean };
  const bucket = (pick: (v: string | undefined) => boolean, voted: boolean): Seat[] =>
    seated.flatMap(({ f, w }) =>
      pick(ballots?.get(f.id))
        ? Array.from({ length: w }, (_, i) => ({ f, i, voted }))
        : []);
  const weigh = (seats: Seat[]) => seats.length;

  const groups: Array<{
    key: string; label: string; tint: string; tip: string;
    seats: Seat[]; weight: number; always: boolean;
  }> = [];
  if (!ballots) {
    const all = bucket(() => true, true);
    groups.push({
      key: 'all', label: t('senate.floor'), tint: '#a8b8c8',
      tip: t('senate.chamber.tip.none'), seats: all, weight: weigh(all), always: true,
    });
  } else {
    const mk = (key: string, label: string, tint: string, tip: string,
                pick: (v: string | undefined) => boolean, voted: boolean,
                always = false) => {
      const seats = bucket(pick, voted);
      groups.push({ key, label, tint, tip, seats, weight: weigh(seats), always });
    };
    mk('yea', t('senate.yea'), '#6ee7b7', t('senate.chamber.tip.yea'), v => v === 'yea', true);
    mk('nay', t('senate.nay'), '#ff5e5e', t('senate.chamber.tip.nay'), v => v === 'nay', true);
    // Abstain and silence share the bottom rail because neither picks a
    // side — but they are NOT the same thing, so an abstention keeps a
    // filled seat (it counts toward quorum) while silence stays
    // outlined (it does not).
    mk('abstain', t('senate.chamber.abstained'), '#c4b5fd', t('senate.chamber.tip.abstain'),
       v => v === 'abstain', true);
    mk('novote', t('senate.chamber.notVoted'), '#8a9fb3', t('senate.chamber.tip.novote'),
       v => v === undefined, false, true);
  }
  return (
    <>
      <div className="sp-sect__h" style={{ marginTop: 14 }}>
        <span className="sp-lbl">{t('senate.chamber')}</span>
        <span className="sp-lbl">
          {quorum ? t('senate.chamber.quorum', { required: quorum.required, eligible: quorum.eligible }) : tn('senate.votes', total)}
        </span>
      </div>
      {ballots && billTitle && (
        <div className="sp-turnout" data-testid="chamber-bill" style={{ marginTop: 2 }}>
          {rich('senate.chamber.seatsShow', { title: <b>{billTitle}</b> })}
          {otherOpen > 0 ? tn('senate.chamber.otherOpen', otherOpen) : '.'}
        </div>
      )}
      {/* Seats split by HOW the seat voted, not just whether it did.
          A single undifferentiated grid could show that a bill had
          attention but never whether it was winning — the actual
          question. Yea and nay face each other; everything that is not
          a side (abstained, or simply silent) sits below, which is also
          where the seats worth chasing for quorum live. */}
      {groups.map(g => (
        (g.seats.length > 0 || g.always) && (
          <div key={g.key} className={`sp-side sp-side--${g.key}`}>
            <div className="sp-side__h">
              <span style={{ color: g.tint }}>{g.label}</span>
              <span className="sp-side__n">
                {tn('senate.votes', g.weight)}
              </span>
            </div>
            <div className="sp-seats">
              {g.seats.map(({ f, i, voted }) => (
                <span
                  key={`${f.id}:${i}`}
                  className={`sp-seat${f.id === myFactionId ? ' is-you' : ''}`
                    + (voted ? '' : ' is-novote')}
                  style={voted
                    ? { background: f.color, color: readableInk(f.color) }
                    : { color: f.color }}
                  title={t('senate.seat.tip', { name: f.name, votes: tn('senate.votes', weightById.get(f.id) ?? 0), tip: g.tip })}
                >
                  {/* The faction's EMBLEM, not its initials. Initials
                      were actively ambiguous here — "Cerean Union" and
                      "Ceres Compact" are both CE — and this grid is
                      scanned, not read: you're looking for whether a
                      bloc has the votes, which is a shape-matching
                      task. */}
                  <FactionEmblem
                    emblem={f.emblem}
                    fallbackKey={f.id}
                    size={13}
                    color={voted ? readableInk(f.color) : f.color}
                  />
                </span>
              ))}
              {g.seats.length === 0 && <span className="sp-side__empty">—</span>}
            </div>
          </div>
        )
      ))}
      <div className="sp-legend">
        {seated.map(({ f, w }) => (
          <span key={f.id} className="sp-lgi" title={f.name}>
            {/* The legend is what teaches the mark: emblem next to the
                name, so the seats above become readable. */}
            <FactionEmblem emblem={f.emblem} fallbackKey={f.id} size={12} color={f.color} />
            {initials(f.name)} {w}
          </span>
        ))}
      </div>
      <div className="sp-note">
        {ballots ? t('senate.chamber.outlined') : t('senate.chamber.total', { n: total })}{' '}
        {quorum
          ? t('senate.chamber.noteQuorum', { required: quorum.required, eligible: quorum.eligible })
          : t('senate.chamber.noteDormant')}
      </div>
    </>
  );
}

/** Black or white ink, whichever reads on this faction colour. Faction
 *  colours run from near-white to deep purple, so a fixed ink is
 *  unreadable at one end. */
function readableInk(hex: string): string {
  const h = (hex || '#888').replace('#', '');
  const parts = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = parts.map(v => (Number.isFinite(v) ? v : 136));
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0a0f16' : '#ffffff';
}
