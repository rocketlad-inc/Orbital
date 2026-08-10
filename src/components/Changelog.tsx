// ============================================================
// Changelog — the "CHANGELOG" tab on the landing page, and the page
// behind orbital-empire.com/changelog.
//
// The body is Lorne's patch-notes document, imported verbatim from the
// .docx rather than paraphrased: this is the note he wrote for the
// players, and a summary of it would be a different (worse) document.
// It renders as a single HTML constant because that preserves the
// authored structure — headings, lists, the parts table — exactly as
// written. The string is a build-time literal with no user input
// anywhere near it, which is what makes setting it as HTML safe here.
//
// To update for the next game: re-export the .docx and replace
// PATCH_NOTES_HTML. Keep the h2 structure — the CSS keys off it.
// ============================================================

import React from 'react';
import './Changelog.css';

interface Props {
  onSignIn: () => void;
}

/** Patch notes for Game 3, as written. */
const PATCH_NOTES_HTML = `
<h2>1. Collectors are dead. Long live terraforming.</h2>
<p>This is the big one. I’ve rewritten how expansion works, and replaced collectors with terraforming.</p>
<p>Every world starts RAW and can be terraformed once you land a station there, and the difference matters a lot:</p>
<ul>
<li><strong>Raw</strong> worlds only kick 10% of their yield back to your treasury. The other 90% just piles up locally — you can spend it on-site (ships and station upgrades), or send a freighter to haul it home, but it's not touching your empire pool on its own.</li>
<li><strong>Terraformed</strong> worlds send you 100% or resources to your stockpile, can host cities and buildings, and can originate trade routes to other players, dyson spheres, or terraforming projects.</li>
</ul>
<p>Your capital and Earth start terraformed. Everything else is raw dirt until you fix it.</p>
<p><strong>To begin terraforming, you must deliver the goods:</strong></p>
<ul>
<li><strong>Scout it.</strong> Visit the world to discovery any secrets.</li>
<li><strong>Claim it.</strong> A colony ship drops a station, cities can no longer be built on worlds that are not terraformed.</li>
<li><strong>Supply it.</strong> Set a freighter on a trade route from a terraformed world to your raw target. It'll load metal and credits from your pool and haul it over.</li>
<li><strong>Wait.</strong> Once 124 metal + 124 credits have physically shown up, a 24-tick countdown starts. The world flips when it hits zero.</li>
<li><strong>Settle it.</strong> Now you can drop a city.</li>
</ul>
<p>A few notes on terraforming:</p>
<ul>
<li>The clock doesn't start until the full payload lands. Partial shipments just sit there banked, patiently, forever.</li>
<li>Terraforming sticks. Conquer a developed world and you keep the work that's already been done. So, don’t want to terraform your own world? Steal someone else's.</li>
<li>The only thing that undoes it is an asteroid strike — which is exactly why the asteroid weapon is scary. It's the one button that un-develops the map.</li>
<li>Gas giants, ice giants, and asteroids can never be terraformed. They're forever staging grounds on the 10% trickle. Use them for what they're good for, and set up trade routes to get faster access to their stockpiles.</li>
</ul>
<h2>2. Cities want Construction 1. Stations want nothing.</h2>
<p>The research requirement moved. Stations — the thing that claims a world — now cost zero research. Cities need Construction 1, which you'll have well before your first terraform even finishes cooking.</p>
<h2>3. Different currencies build different weapons</h2>
<p>It was noted the different types of weapons didn’t make much difference last game, so I’ve made it so that different resources by different weapons. Your weapon type will now be party decided by what’s most affordable for you.</p>
<p>Metal buys kinetic weapons and shields. Credits buy energy weapons and armor. The exchange rate is 8:1, so technically nothing is unbuildable — it's just brutally expensive in the wrong economy.</p>
<div class="cl-tablewrap"><table class="cl-table"><tr><th><strong>Part</strong></th><th><strong>Metal</strong></th><th><strong>Credits</strong></th></tr><tr><td>Kinetic mount</td><td>8</td><td>1</td></tr><tr><td>Shield array</td><td>8</td><td>1</td></tr><tr><td>Energy mount</td><td>1</td><td>8</td></tr><tr><td>Armor plate</td><td>1</td><td>8</td></tr><tr><td>Booster engine</td><td>2</td><td>6</td></tr><tr><td>Fusion detonator</td><td>10</td><td>10</td></tr></table></div>
<p>This pairing is crossed on purpose: shields stop kinetic, armor stops energy. So if you're running a one-currency empire, you will be weaker against an empire specialized in the other currency. You cannot field a complete warship on one economy alone. Go trade.</p>
<p><strong>Heads up:</strong> the default destroyer loadout is all-metal (kinetic + shields), meaning zero armor. Send it against an energy fleet and watch it melt. Refit before you commit to a fight.</p>
<h2>4. You start richer, and your population never stops growing</h2>
<p>Starting resources went from 100/50, to 100/100, and now to <strong>300/300</strong>. Also, population no longer caps at 10. Any settlement you hold grows +1 every 20 ticks, forever, no ceiling. Yield scales with population.</p>
<h2>Combat got rebuilt</h2>
<p>Combat v2 was forged in the fires of the battle of Sol last game:</p>
<ul>
<li>Ships fire <strong>every tick</strong> now, not every third tick.</li>
<li><strong>Peer targeting</strong>: ships go after enemies near their own speed first, then slower, then faster. Speed ties go to the slower ship.</li>
<li>Hit chance is speed-based — attacker² / (attacker² + defender²). Fast ships are genuinely hard to hit, not just nominally.</li>
<li>Stations are basically immobile destroyers now: 400 HP, and they shoot back if you've got Weapons research. Cities still never fire.</li>
<li>You control targeting priority directly — ship cards have drag-and-drop priority lists that show your per-tick hit chance against each hull class, and it applies across bulk orders too. Settlements are always last priority and can't be reordered.</li>
</ul>
<p><strong>Orbital Shields</strong> are a second health bar for settlements — 120 HP per level, regenerating 6/tick, with a grace period after it breaks so a bombardment can actually finish what it started.</p>
<p>Other changes: cities sit at 300 HP and stations at 400 HP, settlements auto-repair between raids, and repair scales +5 HP/tick per shipyard level.</p>
<h2>Captains and fleets</h2>
<p>Captains are a real, limited resource now. You start with 10. More cost 50 metal + 100 credits. They have traits, ranks, names and have a 50% chance of survival if their ship is destroyed.</p>
<p>Veterancy lives on the captain, not the ship. Score a kill with an empty cockpit and you bank nothing. Rank follows the officer, not the hull.</p>
<p>Fleets take orders as a group under a flag captain. One captain per fleet — the flag officer is the only one giving orders.</p>
<h2>The Senate</h2>
<ul>
<li>A chairman rotates in and holds the floor for a 24-tick term. Only they can propose a bill, and only one bill runs at a time — it has to resolve before the term's up.</li>
<li>Bills now require a quorum of active players to pass, no more passing votes with 1 player participating.</li>
<li>Vote weight = 1 + 1 per system you control (systems, not individual bodies). You control a system by holding more of it than any rival; ties are contested and count for nobody.</li>
<li>Debate and voting windows have a 6-tick minimum.</li>
<li>Slider laws can target everyone, or just one named faction.</li>
</ul>
<h2>Winning</h2>
<p>Three ways, and only three:</p>
<ul>
<li><strong>Engineering</strong> — finish the Dyson Sphere at Sol.</li>
<li><strong>Chancellor</strong> — win the Senate vote.</li>
<li><strong>Domination</strong> — hold more than 60% of the map's claimable bodies.</li>
</ul>
<p>The Dyson Sphere is now king-of-the-hill. Blow up the foundation and it doesn't vanish — the builder gets thrown off, 20% of remaining progress tears loose, and the lattice just sits there, unclaimed. Whoever drops the next foundation at Sol inherits the rest and keeps building.</p>
<p>It's also fed by real freighters now, not parked ships doing nothing useful. You need an actual supply route from a terraformed world to Sol — and yes, those freighters can be raided the entire way there.</p>
<h2>Economy</h2>
<ul>
<li>Fleet upkeep now has arrears: corvette 0.25c, frigate 0.5c + 0.5m, destroyer 1c + 1m, freighter 1c. Fall behind on payments and your ships start fighting worse.</li>
<li>Rush construction: pay the cost again to cut remaining build time in half, with a chance it botches.</li>
<li>Ship designer has been rebuilt for easier use.</li>
<li>Standing trade routes: set a deal once and it runs on repeat until something stops it.</li>
<li>Ships can be built straight from a world's local stockpile before touching your pool — so even a raw frontier world can fund its own hulls.</li>
</ul>
<h2>Intel now costs something</h2>
<p>You no longer see everyone's business for free. Rival ship counts, income, and tech levels are all locked behind Sensors research. Territory and system control stay visible to everyone, since they're literally how you win — hiding them would make the whole race unreadable.</p>
<h2>Accounts and profile</h2>
<p>You can rename yourself now. There's a career profile with your win/loss history, friends, a Past Games shelf for finished matches, and faction emblems — pick a flag in the lobby and fly it the whole game. No two factions can share the same one.</p>
`;

export const Changelog: React.FC<Props> = ({ onSignIn }) => (
  <div className="cl">
    <div className="cl-hero">
      <div className="cl-eyebrow">— PATCH NOTES</div>
      <h1 className="cl-title">Game 3</h1>
      <div className="cl-lede">
        Everything that changed since the last playtest. The short version:
        collectors are gone, expansion runs on freighters now, and weapons
        pick a side of your economy.
      </div>
    </div>

    <article
      className="cl-body"
      // Static authored copy, compiled into the bundle. No user input
      // reaches this string.
      dangerouslySetInnerHTML={{ __html: PATCH_NOTES_HTML }}
    />

    <div className="cl-cta">
      <button className="cl-cta-btn" onClick={onSignIn}>PLAY ORBITAL</button>
    </div>
  </div>
);
