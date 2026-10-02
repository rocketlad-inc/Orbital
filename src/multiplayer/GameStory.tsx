// ============================================================
// GameStory — the playtesting view of one game.
//
// Not "what are the yields" but "how is each empire's game going, and
// how is each PLAYER getting on": who hit trouble, who came back from
// it, who is stuck, how far each person has got into the basics, and
// where the game keeps telling them no. Fed by
// /api/admin/games/:id/story (worker/adminDashboard.js).
// ============================================================

import React, { useMemo, useState } from 'react';
import { apiFetch } from './api';
import { ago, labelForKind, playTime } from './adminFormat';
import {
  StoryEvent, StoryPoint, Verdict, VerdictKey, span, tickAt, verdictFor,
} from './storyVerdict';

type StoryFaction = {
  id: string; name: string; color: string; status: string; slot: number;
  user_id: string | null; joined_at: number | null; player_name: string | null; qa: number;
};
type StoryPlayer = {
  user_id: string; faction_id: string; name: string | null; qa: number;
  firsts: Record<string, number>; tries: Record<string, number>; refused: Record<string, number>;
  days: Array<[number, number, number, number]>;
  friction: Array<{ kind: string; code: string; reason: string; n: number; last_ms: number }>;
  totals: {
    minutes: number; actions: number; rejected: number; judged: number; days: number;
    first_day_ms: number; last_beat_ms: number | null; last_action_ms: number | null;
  } | null;
};
export type StoryData = {
  now: number;
  game: { id: string; name: string; status: string; current_tick: number; tick_interval_ms: number; started_at: number | null };
  stride: number;
  factions: StoryFaction[];
  series: Record<string, StoryPoint[]>;
  events: StoryEvent[];
  tally: Record<string, Record<string, number>>;
  losses: Record<string, Array<[number, number]>>;
  arrears: Record<string, number[]>;
  wars: Array<{ a: string; b: string; declared_by: string; t0: number; t1: number | null; origin: string }>;
  ticks: Array<[number, number]>;
  journey_steps: Array<{ id: string; label: string }>;
  players: StoryPlayer[];
};

export async function loadStory(gameId: string) {
  return apiFetch<StoryData>(`/api/admin/games/${gameId}/story`);
}

const n = (v: number | null | undefined) => new Intl.NumberFormat().format(v ?? 0);
/** Triage order: the empires that need a look come first. */
const SEVERITY: VerdictKey[] = ['struggling', 'stalled', 'recovered', 'growing', 'new', 'out'];
const SHORT_STEP: Record<string, string> = {
  built: 'Ship', researched: 'Research', building: 'Building', moved: 'Moved ships',
  colony: 'Colony', social: 'Diplomacy',
};

export function GameStory({ data, onOpenTab }: { data: StoryData; onOpenTab?: (t: string) => void }) {
  const { game, factions, series, events, arrears } = data;
  const byId = useMemo(() => new Map(factions.map(f => [f.id, f])), [factions]);
  const verdicts = useMemo(() => new Map(factions.map(f => [f.id, verdictFor({
    factionId: f.id,
    status: f.status,
    series: series[f.id] ?? [],
    events,
    arrearsTicks: arrears[f.id] ?? [],
    currentTick: game.current_tick,
  })])), [factions, series, events, arrears, game.current_tick]);
  const playerOf = useMemo(() => new Map(data.players.map(p => [p.faction_id, p])), [data.players]);

  const ordered = [...factions].sort((a, b) =>
    SEVERITY.indexOf(verdicts.get(a.id)!.key) - SEVERITY.indexOf(verdicts.get(b.id)!.key)
    || (a.user_id ? 0 : 1) - (b.user_id ? 0 : 1) || a.slot - b.slot);

  const alive = factions.filter(f => verdicts.get(f.id)!.key !== 'out').length;
  const openWars = data.wars.filter(w => w.t1 == null).length;
  const coloniesLost = events.filter(e => e.kind === 'settlement_destroyed' || e.kind === 'settlement_seized').length;
  const shipsLost = Object.values(data.tally).reduce((s, t) => s + (t.ship_destroyed ?? 0), 0);
  const refused = data.players.reduce((s, p) => s + (p.totals?.rejected ?? 0), 0);
  // Rates divide by tries that carry an outcome, never all tries.
  const attempted = data.players.reduce((s, p) => s + (p.totals?.judged ?? 0), 0);
  const playedToday = data.players.filter(p => p.totals?.last_beat_ms && data.now - p.totals.last_beat_ms < 86_400_000).length;
  const counts = SEVERITY.map(k => [k, factions.filter(f => verdicts.get(f.id)!.key === k).length] as const).filter(([, c]) => c > 0);

  return (
    <div className="ao-stack">
      <div className="ao-kpis ao-kpis--game">
        <Stat label="Tick" value={`T${n(game.current_tick)}`} foot={`${Math.round(game.tick_interval_ms / 60000)} min per tick`} />
        <Stat label="Empires still in" value={`${alive} / ${factions.length}`} foot={counts.map(([k, c]) => `${c} ${k}`).join(' · ')} />
        <Stat label="Humans played today" value={`${playedToday} / ${data.players.filter(p => !p.qa).length}`} foot="had the game open in the last 24h" />
        <Stat label="Wars" value={n(openWars)} foot={`${n(data.wars.length)} declared in total`} />
        <Stat label="Losses" value={`${n(coloniesLost)} · ${n(shipsLost)}`} foot="colonies · ships destroyed" />
        <Stat
          label="Actions refused"
          value={attempted ? `${Math.round((refused / attempted) * 100)}%` : '—'}
          foot={refused ? `${n(refused)} of ${n(attempted)} tries` : 'none recorded yet'}
          warn={attempted > 0 && refused / attempted > 0.12}
        />
      </div>

      <section className="ao-panel">
        <Head
          title="How each empire is doing"
          hint="Colonies and fleet over the whole game, with what went wrong marked on it. Empires that need a look come first. The label is read from the numbers; the line under it says which ones."
        />
        <div className="gs-legend">
          <span><i className="gs-key gs-key--col" />colonies</span>
          <span><i className="gs-key gs-key--fleet" />fleet</span>
          <span><i className="gs-key gs-key--setback">▼</i>setback</span>
          <span><i className="gs-key gs-key--arrears" />in arrears</span>
          <span><i className="gs-key gs-key--war" />war declared</span>
        </div>
        <div className="gs-cards">
          {ordered.map(f => (
            <EmpireCard
              key={f.id}
              f={f}
              verdict={verdicts.get(f.id)!}
              series={series[f.id] ?? []}
              arrears={arrears[f.id] ?? []}
              wars={data.wars.filter(w => w.a === f.id || w.b === f.id)}
              tally={data.tally[f.id] ?? {}}
              player={playerOf.get(f.id)}
              now={data.now}
              maxTick={Math.max(1, game.current_tick)}
              nameOf={(id) => byId.get(id)?.name ?? 'someone'}
            />
          ))}
        </div>
      </section>

      <section className="ao-panel">
        <Head
          title="How far each player has got"
          hint="The basics, in the order the game teaches them. A filled dot is done, with how long after joining it took. A red ring means they tried and the game refused them every time."
        />
        <Journeys data={data} />
      </section>

      <section className="ao-panel">
        <Head
          title="Where players hit walls"
          hint="Actions the game refused in this match, by reason. One player hitting the same wall again and again is someone who does not understand why."
        />
        <Friction data={data} />
      </section>

      <section className="ao-panel">
        <Head title="The story so far" hint="Everything that changed an empire's fortunes, newest first." />
        <Timeline data={data} byId={byId} />
      </section>
      {onOpenTab && (
        <p className="ao-note">
          Balance detail lives in the other tabs:{' '}
          <button className="ao-link" onClick={() => onOpenTab('economy')}>economy</button>,{' '}
          <button className="ao-link" onClick={() => onOpenTab('combat')}>combat</button>,{' '}
          <button className="ao-link" onClick={() => onOpenTab('politics')}>politics and trade</button>.
        </p>
      )}
    </div>
  );
}

function Head({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="ao-phead">
      <div>
        <h3 className="ao-phead__title">{title}</h3>
        {hint && <p className="ao-phead__hint">{hint}</p>}
      </div>
    </div>
  );
}

function Stat({ label, value, foot, warn }: { label: string; value: string; foot?: string; warn?: boolean }) {
  return (
    <div className="ao-kpi">
      <span className="ao-kpi__label">{label}</span>
      <span className={`ao-kpi__value${warn ? ' ao-warn' : ''}`}>{value}</span>
      {foot && <span className="ao-kpi__foot">{foot}</span>}
    </div>
  );
}

// ---------- empire cards ----------

function EmpireCard({ f, verdict, series, arrears, wars, tally, player, now, maxTick, nameOf }: {
  f: StoryFaction; verdict: Verdict; series: StoryPoint[]; arrears: number[];
  wars: StoryData['wars']; tally: Record<string, number>; player?: StoryPlayer;
  now: number; maxTick: number; nameOf: (id: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300, HC = 64, HF = 30;
  const x = (t: number) => (t / maxTick) * W;
  const peakCol = Math.max(1, ...series.map(p => p[1]));
  const peakShips = Math.max(1, ...series.map(p => p[2]));
  const yc = (v: number) => HC - 3 - (v / peakCol) * (HC - 8);
  const yf = (v: number) => HF - 1 - (v / peakShips) * (HF - 3);
  // Step line: a colony count holds until it changes.
  const colPath = series.map((p, i) => `${i ? `L${x(p[0]).toFixed(1)},${yc(series[i - 1][1]).toFixed(1)} ` : 'M'}${x(p[0]).toFixed(1)},${yc(p[1]).toFixed(1)}`).join(' ');
  const fleetLine = series.map(p => `${x(p[0]).toFixed(1)},${yf(p[2]).toFixed(1)}`).join(' ');
  const fleetArea = series.length ? `M${x(series[0][0])},${HF} L${fleetLine.replace(/ /g, ' L')} L${x(series[series.length - 1][0])},${HF} Z` : '';
  // Arrears as bands, one per unbroken run.
  const bands: Array<[number, number]> = [];
  for (const t of arrears) {
    const lastBand = bands[bands.length - 1];
    if (lastBand && t <= lastBand[1] + 1) lastBand[1] = t; else bands.push([t, t]);
  }
  const point = hover == null ? series[series.length - 1] : series.reduce((best, p) => (Math.abs(p[0] - hover) < Math.abs(best[0] - hover) ? p : best), series[0]);
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(maxTick, Math.round(((e.clientX - r.left) / r.width) * maxTick))));
  };
  const human = !!f.user_id;
  const lastSeen = player?.totals?.last_beat_ms ?? null;
  const absent = human && !player?.qa && (lastSeen == null || now - lastSeen > 3 * 86_400_000);

  return (
    <article className={`gs-card gs-card--${verdict.key}`}>
      <header className="gs-card__head">
        <span className="gs-dot" style={{ background: f.color }} />
        <div className="gs-card__who">
          <span className="gs-card__name">{f.name}</span>
          <span className="gs-card__player">
            {human ? (f.player_name ?? 'a player') : 'AI empire'}
            {!!f.qa && <span className="gs-tag">bot</span>}
            {absent && <span className="gs-tag gs-tag--warn">away {lastSeen ? ago(now, lastSeen).replace(' ago', '') : 'always'}</span>}
          </span>
        </div>
        <span className={`gs-verdict gs-verdict--${verdict.key}`}>{verdict.label}</span>
      </header>
      <p className="gs-card__reason">{verdict.reason}</p>

      <div className="gs-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {series.length < 2 ? <div className="ao-none">No history recorded.</div> : (
          <>
            <svg viewBox={`0 0 ${W} ${HC}`} preserveAspectRatio="none" className="gs-chart__col" aria-hidden>
              {bands.map(([a, b]) => <rect key={a} x={x(a)} y={0} width={Math.max(2, x(b + 1) - x(a))} height={HC} className="gs-band" />)}
              {wars.map(w => <line key={`${w.a}${w.b}${w.t0}`} x1={x(w.t0)} x2={x(w.t0)} y1={0} y2={HC} className="gs-war" vectorEffect="non-scaling-stroke" />)}
              <path d={colPath} className="gs-col" vectorEffect="non-scaling-stroke" />
              {hover != null && <line x1={x(point[0])} x2={x(point[0])} y1={0} y2={HC} className="gs-cursor" vectorEffect="non-scaling-stroke" />}
            </svg>
            <svg viewBox={`0 0 ${W} ${HF}`} preserveAspectRatio="none" className="gs-chart__fleet" aria-hidden>
              {bands.map(([a, b]) => <rect key={a} x={x(a)} y={0} width={Math.max(2, x(b + 1) - x(a))} height={HF} className="gs-band" />)}
              <path d={fleetArea} className="gs-fleet-area" />
              <polyline points={fleetLine} className="gs-fleet" vectorEffect="non-scaling-stroke" />
              {hover != null && <line x1={x(point[0])} x2={x(point[0])} y1={0} y2={HF} className="gs-cursor" vectorEffect="non-scaling-stroke" />}
            </svg>
            {/* Setback glyphs are HTML over the SVG so they stay round
                and readable however the card stretches. */}
            {verdict.setbacks.map((s, i) => (
              <span
                key={`${s.t}${i}`}
                className="gs-setback"
                style={{ left: `${(s.t / maxTick) * 100}%` }}
                title={`T${s.t}: ${s.what}`}
              >▼</span>
            ))}
          </>
        )}
      </div>
      {series.length >= 2 && (
        <div className="gs-readout">
          <b>T{point[0]}</b>
          <span>{point[1]} {point[1] === 1 ? 'colony' : 'colonies'}</span>
          <span>{point[2]} ships</span>
          <span>{n(point[3])} metal</span>
          <span>{n(point[4])} credits</span>
          {hover != null && arrears.includes(point[0]) && <span className="ao-warn">in arrears</span>}
        </div>
      )}

      <dl className="gs-facts">
        <div><dt>Ships built</dt><dd>{n(tally.ship_built)}</dd></div>
        <div><dt>Lost</dt><dd>{n(tally.ship_destroyed)}</dd></div>
        <div><dt>Sank</dt><dd>{n(tally.kills)}</dd></div>
        <div><dt>Techs</dt><dd>{n(tally.tech_advanced)}</dd></div>
        <div><dt>Peak colonies</dt><dd>{n(peakCol)}</dd></div>
        <div><dt>At war with</dt><dd className="gs-facts__wide">{
          wars.filter(w => w.t1 == null).map(w => nameOf(w.a === f.id ? w.b : w.a)).join(', ') || 'nobody'
        }</dd></div>
      </dl>
      {player?.totals && (
        <p className="gs-card__play">
          Played {playTime(player.totals.minutes)} over {player.totals.days} {player.totals.days === 1 ? 'day' : 'days'}
          {' · '}{n(player.totals.actions)} actions
          {player.totals.rejected ? <>, <span className="ao-warn">{n(player.totals.rejected)} refused</span></> : null}
          {' · '}last seen {ago(now, player.totals.last_beat_ms)}
        </p>
      )}
    </article>
  );
}

// ---------- journeys ----------

function Journeys({ data }: { data: StoryData }) {
  const factionOf = new Map(data.factions.map(f => [f.id, f]));
  const players = [...data.players].sort((a, b) => a.qa - b.qa || (b.totals?.minutes ?? 0) - (a.totals?.minutes ?? 0));
  if (players.length === 0) return <div className="ao-none">No human players in this game.</div>;
  const steps = data.journey_steps;
  const done = (id: string) => players.filter(p => !p.qa && p.firsts[id] != null).length;
  const humans = players.filter(p => !p.qa).length;
  return (
    <div className="ao-scroll">
      <table className="ao-table gs-journey">
        <thead>
          <tr>
            <th>Player</th>
            {steps.map(s => (
              <th key={s.id} className="gs-journey__step" title={s.label}>
                {SHORT_STEP[s.id] ?? s.label}
                <span className="gs-journey__pct">{humans ? `${done(s.id)}/${humans}` : ''}</span>
              </th>
            ))}
            <th className="num">Played</th>
            <th>Every day of this game</th>
            <th className="num">Refused</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {players.map(p => {
            const f = factionOf.get(p.faction_id);
            const joined = f?.joined_at ?? p.totals?.first_day_ms ?? null;
            const t = p.totals;
            const rate = t && t.judged ? t.rejected / t.judged : 0;
            return (
              <tr key={p.user_id}>
                <td>
                  <span className="ao-name"><span className="gs-dot gs-dot--sm" style={{ background: f?.color }} />{p.name ?? 'player'}{!!p.qa && <span className="gs-tag">bot</span>}</span>
                  <span className="ao-sub">{f?.name}</span>
                </td>
                {steps.map(s => {
                  const at = p.firsts[s.id];
                  const tries = p.tries[s.id] ?? 0;
                  const refusedAll = at == null && tries > 0;
                  const tick = at != null ? tickAt(data.ticks, at) : null;
                  const title = at != null
                    ? `${s.label}: ${joined ? `${span(at - joined)} after joining` : ''}${tick != null ? ` (T${tick})` : ''}${p.refused[s.id] ? ` · refused ${p.refused[s.id]}× along the way` : ''}`
                    : refusedAll ? `${s.label}: tried ${tries}× and was refused every time` : `${s.label}: not yet`;
                  return (
                    <td key={s.id} className="gs-journey__cell" title={title}>
                      <span className={`gs-step${at != null ? ' is-done' : ''}${refusedAll ? ' is-blocked' : ''}`} aria-label={title} />
                      <span className="gs-step__when">{at != null && joined ? span(at - joined) : refusedAll ? `${tries}× no` : ''}</span>
                    </td>
                  );
                })}
                <td className="num">{t ? playTime(t.minutes) : '—'}</td>
                <td><GameDays days={p.days} /></td>
                <td className={`num${rate > 0.15 ? ' ao-warn' : ''}`}>{t?.rejected ? `${n(t.rejected)} · ${Math.round(rate * 100)}%` : '—'}</td>
                <td className="ao-dim">{t?.last_beat_ms ? ago(data.now, t.last_beat_ms) : 'never'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One cell per day of this game the player could have played, from
 *  the first to today, brightness = minutes; refusals tint it amber. */
function GameDays({ days }: { days: StoryPlayer['days'] }) {
  if (days.length === 0) return <span className="ao-dim">—</span>;
  const DAY = 86_400_000;
  const first = days[0][0];
  const last = Math.max(days[days.length - 1][0], Math.floor(Date.now() / DAY) * DAY);
  const count = Math.min(60, Math.round((last - first) / DAY) + 1);
  const start = last - (count - 1) * DAY;
  const by = new Map<number, [number, number]>();
  for (const [d, m, , r] of days) {
    const cur = by.get(d) ?? [0, 0];
    by.set(d, [cur[0] + m, cur[1] + r]);
  }
  const max = Math.max(30, ...[...by.values()].map(v => v[0]));
  return (
    <span className="gs-days">
      {Array.from({ length: count }, (_, i) => {
        const d = start + i * DAY;
        const [m, r] = by.get(d) ?? [0, 0];
        return (
          <i
            key={d}
            className={r > 2 ? 'is-friction' : ''}
            style={{ '--a': m ? 0.25 + 0.75 * Math.min(1, m / max) : 0 } as React.CSSProperties}
            title={`${new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${m ? playTime(m) : 'not played'}${r ? `, ${r} refused` : ''}`}
          />
        );
      })}
    </span>
  );
}

// ---------- friction ----------

function Friction({ data }: { data: StoryData }) {
  const rows = new Map<string, { kind: string; code: string; reason: string; n: number; players: Set<string>; last: number }>();
  for (const p of data.players) {
    if (p.qa) continue;
    for (const r of p.friction) {
      const key = `${r.kind}|${r.code}|${r.reason}`;
      const cur = rows.get(key) ?? { kind: r.kind, code: r.code, reason: r.reason, n: 0, players: new Set<string>(), last: 0 };
      cur.n += r.n;
      cur.players.add(p.name ?? p.user_id);
      cur.last = Math.max(cur.last, r.last_ms);
      rows.set(key, cur);
    }
  }
  const list = [...rows.values()].sort((a, b) => b.n - a.n);
  if (list.length === 0) {
    return <div className="ao-none">No refused actions recorded in this game. Outcomes are recorded from the 1 October update on.</div>;
  }
  const max = list[0].n;
  return <FrictionRows rows={list.slice(0, 15).map(r => ({ ...r, who: [...r.players] }))} max={max} now={data.now} />;
}

export function FrictionRows({ rows, max, now }: {
  rows: Array<{ kind: string; code: string; reason: string; n: number; who?: string[]; last?: number }>;
  max: number; now: number;
}) {
  return (
    <div className="gs-friction">
      {rows.map(r => (
        <div key={`${r.kind}|${r.code}|${r.reason}`} className="gs-friction__row">
          <div className="gs-friction__what">
            <span className="gs-friction__action">{labelForKind(r.kind)}</span>
            <span className="gs-friction__why">{r.reason ? `“${r.reason}”` : codeLabel(r.code)}</span>
          </div>
          <span className="gs-friction__bar"><i style={{ width: `${(r.n / Math.max(1, max)) * 100}%` }} /></span>
          <span className="gs-friction__n">{n(r.n)}×</span>
          <span className="gs-friction__who">
            {r.who ? `${r.who.length} ${r.who.length === 1 ? 'player' : 'players'}` : ''}
            {r.last ? ` · ${ago(now, r.last)}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Handler codes in words, for refusals whose message was empty. */
export function codeLabel(code: string): string {
  const known: Record<string, string> = {
    insufficient_resources: 'could not afford it',
    not_owner: 'not theirs to command',
    not_yours: 'not theirs to command',
    in_transit: 'ship was in flight',
    in_combat: 'ship was in combat',
    not_active: 'no longer active',
    conflict: 'something changed underneath them',
    not_member: 'not a member of this game',
    not_found: 'target no longer exists',
    bad_request: 'the request was invalid',
    worker_exception: 'server error',
  };
  return known[code] ?? code.replace(/_/g, ' ');
}

// ---------- timeline ----------

type Filter = 'all' | 'setbacks' | 'growth' | 'diplomacy';
const FILTER_KINDS: Record<Exclude<Filter, 'all'>, string[]> = {
  setbacks: ['settlement_destroyed', 'settlement_seized', 'settlement_razed', 'faction_eliminated', 'fleet_arrears', 'ship_rush_botched', 'settle_refused', 'trade_route_stalled', 'hold_full', 'captain_lost'],
  growth: ['settlement_built', 'terraform_complete', 'megastructure_complete', 'dyson_milestone', 'faction_revived', 'faction_joined', 'secret_discovered', 'victory'],
  diplomacy: ['war_declared', 'war_ended', 'treaty_signed'],
};

function Timeline({ data, byId }: { data: StoryData; byId: Map<string, StoryFaction> }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [all, setAll] = useState(false);
  const list = data.events
    .filter(e => filter === 'all' || FILTER_KINDS[filter].includes(e.kind))
    .slice()
    .reverse();
  const shown = all ? list : list.slice(0, 30);
  const name = (id: string | null) => {
    const f = id ? byId.get(id) : null;
    return f ? <span className="gs-who"><span className="gs-dot gs-dot--sm" style={{ background: f.color }} />{f.name}</span> : <span>someone</span>;
  };
  return (
    <div>
      <div className="ao-seg gs-filter" role="group" aria-label="Which events">
        {(['all', 'setbacks', 'growth', 'diplomacy'] as Filter[]).map(k => (
          <button key={k} className={`ao-seg__opt${filter === k ? ' is-active' : ''}`} onClick={() => setFilter(k)}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="ao-none">Nothing of that kind has happened yet.</div>}
      <ol className="gs-timeline">
        {shown.map((e, i) => (
          <li key={`${e.t}${e.kind}${i}`} className={`gs-ev gs-ev--${tone(e.kind, e.d)}`}>
            <span className="gs-ev__t">T{e.t}</span>
            <span className="gs-ev__text">{sentence(e, name)}</span>
          </li>
        ))}
      </ol>
      {list.length > 30 && (
        <button className="ao-link" onClick={() => setAll(a => !a)}>{all ? 'Show the latest 30' : `Show all ${list.length}`}</button>
      )}
    </div>
  );
}

function tone(kind: string, d: Record<string, unknown>): 'bad' | 'good' | 'war' | 'plain' {
  if (kind === 'fleet_arrears') return d.entered === false ? 'good' : 'bad';
  if (FILTER_KINDS.setbacks.includes(kind)) return 'bad';
  if (FILTER_KINDS.growth.includes(kind)) return 'good';
  if (kind === 'war_declared') return 'war';
  return 'plain';
}

function sentence(e: StoryEvent, who: (id: string | null) => React.ReactNode): React.ReactNode {
  const d = e.d as Record<string, string | number | boolean | null>;
  const at = d.body ? ` on ${d.body}` : '';
  switch (e.kind) {
    case 'settlement_built': return <>{who(e.f)} founded {d.name ?? 'a colony'}{at}</>;
    case 'settlement_destroyed': return <>{who(e.f)} lost {d.name ?? 'a colony'}{at}</>;
    case 'settlement_razed': return <>{who(e.f)} razed {d.name ?? 'a colony'}{at}</>;
    case 'settlement_seized': return <>{who(e.f)} seized {d.name ?? 'a colony'} from {who(e.o)}</>;
    case 'faction_eliminated': return <>{who(e.f)} was eliminated{d.cause === 'no_settlements' ? ', with no colonies left' : ''}</>;
    case 'faction_revived': return <>{who(e.f)} came back into the game</>;
    case 'faction_joined': return <>{who(e.f)} joined the game</>;
    case 'fleet_arrears': return d.entered === false ? <>{who(e.f)} paid off its arrears</> : <>{who(e.f)} fell into arrears: upkeep outran income</>;
    case 'war_declared': return <>{who(e.f)} declared war on {who(e.o)}</>;
    case 'war_ended': return <>{who(e.f)} and {who(e.o)} made peace</>;
    case 'treaty_signed': return <>{who(e.f)} signed a treaty{e.o ? <> with {who(e.o)}</> : null}</>;
    case 'terraform_complete': return <>{who(e.f)} finished terraforming{d.body ? ` ${d.body}` : ''}</>;
    case 'megastructure_complete': return <>{who(e.f)} completed a megastructure</>;
    case 'dyson_milestone': return <>{who(e.f)} reached a Dyson milestone</>;
    case 'victory': return <>{who(e.f)} won the game</>;
    case 'ship_rush_botched': return <>{who(e.f)} botched a rushed {d.ship_class ?? 'ship'}</>;
    case 'settle_refused': return <>{who(e.f)} was refused a colony{d.reason ? `: ${String(d.reason).toLowerCase()}` : ''}</>;
    case 'trade_route_stalled': return <>{who(e.f)} has a stalled trade route</>;
    case 'hold_full': return <>{who(e.f)}: a mining ship’s hold is full</>;
    case 'captain_lost': return <>{who(e.f)} lost a captain{at}</>;
    case 'secret_discovered': return <>{who(e.f)} discovered a secret</>;
    case 'game_started': return <>The game began</>;
    default: return <>{who(e.f)}: {e.kind.replace(/_/g, ' ')}</>;
  }
}
