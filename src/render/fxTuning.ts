// ------------------------------------------------------------
// Combat effect tuning: the colours and the clock of a fight.
//
// ONE SET OF NUMBERS FOR EVERY SURFACE. The map (combatFx.ts, fxArt.ts)
// reads these, and the server hands the same object to the watch inside
// worlds.json (worker/wearWorlds.js `fx`), which animates its Porthole
// with them. So "slow the fire rate" is one edit here and a deploy: the
// game and every watch change together, with no app release. Only a
// brand-new KIND of effect needs the watch app to learn to draw it.
//
// Keep it plain data (strings and numbers): it crosses to Kotlin as JSON.
// Bump `v` when a field changes meaning, never for a new value.
// ------------------------------------------------------------

export interface FxPaletteTuning { core: string; glow: string; haze: string }

export const FX_TUNING = {
  v: 1,
  /** The weapon colours the shot, not the faction: kinetic is amber,
   *  energy is cyan, a shield is teal, fire is fire. */
  kinetic: { core: '#fff4d8', glow: '#ffae4a', haze: '#ff7a1a' } as FxPaletteTuning,
  energy: { core: '#f2fdff', glow: '#5cc8ff', haze: '#2f86ff' } as FxPaletteTuning,
  shield: { core: '#eafffd', glow: '#4ee6d8', haze: '#1fa5c4' } as FxPaletteTuning,
  fire: { core: '#fff6dc', glow: '#ff9a3c', haze: '#d2401a' } as FxPaletteTuning,

  /** One shot crosses the gap in this long. */
  boltMs: 750,
  /** Reload after each shot lands, per hull. A volley every boltMs +
   *  beatMs (~3.2 s); it was 500 ms and read as ships "on crack". */
  beatMs: 2400,
  /** Hulls a fight holds before each one fires less often, so a big
   *  battle stays watchable: past this the cycle stretches in proportion.
   *  18 (was 6): Lorne picked 3x the fire on the battle test page
   *  (2026-10-06). Tripling this triples every crowded fight's rate and
   *  leaves a skirmish of up to 18 hulls on its ~3.2 s volley, the rate
   *  he settled on 2026-10-01 after ~1.1 s read as ships "on crack". */
  fireReference: 18,
  /** Muzzle flash at the start of each round. */
  muzzleMs: 130,
  /** The hit after a shot lands, inside the reload. */
  impactMs: 380,
  /** Gap between the rounds of a kinetic burst. */
  roundGapMs: 70,
  /** Rounds in one kinetic burst, by the shooter's hull (Lorne,
   *  2026-10-06): a corvette fires one, a frigate two, a destroyer three.
   *  THE LOOK ONLY: the server still rolls one volley per hull per tick
   *  and its damage is untouched. Anything else that fires kinetic
   *  (stations, capital hulls) keeps the full burst. Flat numbers, not a
   *  map, so they cross to Kotlin like every other field. */
  kineticRoundsCorvette: 1,
  kineticRoundsFrigate: 2,
  kineticRoundsDestroyer: 3,
  kineticRoundsOther: 3,
  /** An energy shot's charge, inside boltMs, before the beam. */
  chargeMs: 180,

  /** One flak air-burst's life, and how often each stream throws one. */
  flakBurstMs: 1000,
  flakCycleMs: 750,
  flakMaxStreams: 9,
  /** A hull hit within this many ticks burns; so does one under a third. */
  damageShowTicks: 1,
  crippledBelow: 0.34,
  /** Damaged hulls catch fire one by one, never on one frame. */
  igniteDelayMs: 550,
  igniteRampMs: 450,

  /** A death: the fireball's whole life, then the hull's own pieces
   *  flying apart (they stay as wreckage for the wreck's tick window). */
  explosionMs: 1600,
  breakupFlyMs: 1800,
  breakupHeatMs: 2600,
};

export type FxTuning = typeof FX_TUNING;

/** Rounds in a kinetic burst for a shooter of this class (undefined for a
 *  settlement or a Weapons Station). The watch's FxTuning.roundsFor is the
 *  same table. */
export function kineticRoundsOf(cls: string | undefined, fx: FxTuning = FX_TUNING): number {
  switch (cls) {
    case 'corvette': return fx.kineticRoundsCorvette;
    case 'frigate': return fx.kineticRoundsFrigate;
    case 'destroyer': return fx.kineticRoundsDestroyer;
    default: return fx.kineticRoundsOther;
  }
}

/** Where round `r` of an `n`-round burst sits on the shared clock. The
 *  burst always has at least three slots and fires from the LAST n of
 *  them, so every round flies at the same speed whatever the hull and the
 *  final round lands with the volley's big hit at boltMs. A three-round
 *  burst is exactly the timing it always had. */
export function burstSlots(n: number, fx: FxTuning = FX_TUNING): { first: number; slots: number; flight: number } {
  const rounds = Math.max(1, Math.round(n));
  const slots = Math.max(3, rounds);
  return { first: slots - rounds, slots, flight: fx.boltMs - (slots - 1) * fx.roundGapMs };
}
