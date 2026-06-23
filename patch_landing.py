"""One-off patch script for src/components/Landing.tsx — keep the landing
copy + SVG mocks accurate to the current game state."""
from pathlib import Path

p = Path("src/components/Landing.tsx")
text = p.read_text(encoding="utf-8")

# 1) Tech track copy: 'yields' isn't a real track
OLD_TECH = ('body="Seven tech tracks scale weapons, armor, propulsion, '
            'sensors, and yields. Hidden caches, derelict warships, and '
            'ancient databanks wait on random moons — every match '
            'seeds them differently. Send ships out to find them."')
NEW_TECH = ('body="Seven tech tracks — weapons, armor, propulsion, '
            'flight dynamics, construction, industry, sensors — each '
            'capped at level 10. Hidden caches, derelict warships, and '
            'ancient databanks wait on random moons; every match seeds '
            'them differently. Send ships out to find them."')
assert OLD_TECH in text, "tech copy anchor missing"
text = text.replace(OLD_TECH, NEW_TECH, 1)
print("OK: tech-tracks copy")

# 2) Hero SolarSystemMock: straight-line transfer + Mars further from
#    belt + add belt stippling.
OLD_HERO = '''    {/* Orbits */}
    <circle cx="300" cy="180" r="90" stroke="#2d4255" strokeWidth="1" fill="none" />
    <circle cx="300" cy="180" r="150" stroke="#3d2820" strokeWidth="1" fill="none" />

    {/* Sun glow + core */}
    <circle cx="300" cy="180" r="80" fill="url(#sunGlow)" />
    <circle cx="300" cy="180" r="14" fill="url(#sunCore)" />

    {/* Earth */}
    <circle cx="390" cy="180" r="9" fill="url(#earthGrad)" />
    <text x="390" y="208" textAnchor="middle" className="mock-label">EARTH</text>

    {/* Mars */}
    <circle cx="225" cy="245" r="7" fill="url(#marsGrad)" />
    <text x="225" y="270" textAnchor="middle" className="mock-label">MARS</text>

    {/* Bezier transfer arc */}
    <path
      d="M 390 180 C 410 100, 280 90, 225 245"
      stroke="#ffb84d"
      strokeWidth="1.5"
      fill="none"
      strokeDasharray="0"
    />

    {/* Ship */}
    <g transform="translate(330 130)">
      <circle r="4" fill="#4ecdc4" />
      <line x1="0" y1="0" x2="6" y2="-3" stroke="#6ee7b7" strokeWidth="1.5" />
      <text x="0" y="-12" textAnchor="middle" className="mock-label-sm">ROCINANTE</text>
    </g>'''

NEW_HERO = '''    {/* Orbits — Earth, Mars, gas giant beyond the belt */}
    <circle cx="300" cy="180" r="90"  stroke="#2d4255" strokeWidth="1" fill="none" />
    <circle cx="300" cy="180" r="135" stroke="#3d2820" strokeWidth="1" fill="none" />
    <circle cx="300" cy="180" r="215" stroke="#3d2820" strokeWidth="0.8" fill="none" />

    {/* Sun glow + core */}
    <circle cx="300" cy="180" r="80" fill="url(#sunGlow)" />
    <circle cx="300" cy="180" r="14" fill="url(#sunCore)" />

    {/* Asteroid belt — stippled annulus between Mars and the outer orbit */}
    <g opacity="0.55">
      {Array.from({ length: 70 }).map((_, i) => {
        const a = (i / 70) * Math.PI * 2 + (i % 3) * 0.04;
        const rJitter = 165 + ((i * 13) % 25);
        const cx = 300 + Math.cos(a) * rJitter;
        const cy = 180 + Math.sin(a) * rJitter;
        return <circle key={i} cx={cx} cy={cy} r={0.9} fill="#a89878" />;
      })}
    </g>

    {/* Earth */}
    <circle cx="390" cy="180" r="9" fill="url(#earthGrad)" />
    <text x="390" y="208" textAnchor="middle" className="mock-label">EARTH</text>

    {/* Mars — on its own orbit, clear of the belt */}
    <circle cx="218" cy="252" r="7" fill="url(#marsGrad)" />
    <text x="218" y="278" textAnchor="middle" className="mock-label">MARS</text>

    {/* Straight-line transfer (matches the in-game render) */}
    <line
      x1="390" y1="180" x2="218" y2="252"
      stroke="#ffb84d"
      strokeWidth="1.5"
    />

    {/* Ship — ~40% of the way from Earth to Mars along the segment */}
    <g transform="translate(321 209)">
      <circle r="4" fill="#4ecdc4" />
      <line x1="0" y1="0" x2="-5" y2="2" stroke="#6ee7b7" strokeWidth="1.5" />
      <text x="0" y="-12" textAnchor="middle" className="mock-label-sm">ROCINANTE</text>
    </g>'''
assert OLD_HERO in text, "hero anchor missing"
text = text.replace(OLD_HERO, NEW_HERO, 1)
print("OK: hero mock")

# 3) ScreenshotSolarSystem: add belt, relabel Jupiter (with ring graphic) to Saturn
OLD_SS1 = '''    {/* Orbits */}
    <circle cx="200" cy="120" r="50" stroke="#2d4255" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="85" stroke="#3d2820" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="115" stroke="#5a3a1a" strokeWidth="0.7" fill="none" />

    {/* Sun */}
    <circle cx="200" cy="120" r="40" fill="url(#ss1Sun)" />
    <circle cx="200" cy="120" r="8" fill="#fff8e0" />
    <text x="200" y="140" textAnchor="middle" className="ss-label">SOL</text>

    {/* Inner planet */}
    <circle cx="250" cy="120" r="4" fill="#7fb3d5" />
    <text x="250" y="135" textAnchor="middle" className="ss-label">EARTH</text>

    {/* Mid planet */}
    <circle cx="200" cy="205" r="3.5" fill="#d8784a" />
    <text x="200" y="220" textAnchor="middle" className="ss-label">MARS</text>

    {/* Outer planet (gas giant w/ ring) */}
    <ellipse cx="115" cy="120" rx="11" ry="2.5" stroke="#d4a574" strokeWidth="0.8" fill="none" />
    <circle cx="115" cy="120" r="6" fill="#d4a574" />
    <text x="115" y="138" textAnchor="middle" className="ss-label">JUPITER</text>

    {/* Ship */}
    <circle cx="245" cy="115" r="2.5" fill="#4ecdc4" />'''

NEW_SS1 = '''    {/* Orbits */}
    <circle cx="200" cy="120" r="50"  stroke="#2d4255" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="80"  stroke="#3d2820" strokeWidth="0.7" fill="none" />
    <circle cx="200" cy="120" r="115" stroke="#3d2820" strokeWidth="0.6" fill="none" />

    {/* Sun */}
    <circle cx="200" cy="120" r="40" fill="url(#ss1Sun)" />
    <circle cx="200" cy="120" r="8" fill="#fff8e0" />
    <text x="200" y="140" textAnchor="middle" className="ss-label">SOL</text>

    {/* Inner planet */}
    <circle cx="250" cy="120" r="4" fill="#7fb3d5" />
    <text x="250" y="135" textAnchor="middle" className="ss-label">EARTH</text>

    {/* Mars */}
    <circle cx="200" cy="200" r="3.5" fill="#d8784a" />
    <text x="200" y="216" textAnchor="middle" className="ss-label">MARS</text>

    {/* Asteroid belt — stippled band between Mars and the gas giant */}
    <g opacity="0.55">
      {Array.from({ length: 55 }).map((_, i) => {
        const a = (i / 55) * Math.PI * 2 + (i % 4) * 0.05;
        const rJitter = 96 + ((i * 11) % 14);
        const cx = 200 + Math.cos(a) * rJitter;
        const cy = 120 + Math.sin(a) * rJitter;
        return <circle key={`belt-${i}`} cx={cx} cy={cy} r={0.7} fill="#a89878" />;
      })}
    </g>

    {/* Saturn — the ring graphic is unambiguously saturnine, label matches */}
    <ellipse cx="115" cy="120" rx="11" ry="2.5" stroke="#d4a574" strokeWidth="0.8" fill="none" />
    <circle cx="115" cy="120" r="6" fill="#d4a574" />
    <text x="115" y="138" textAnchor="middle" className="ss-label">SATURN</text>

    {/* Ship */}
    <circle cx="245" cy="115" r="2.5" fill="#4ecdc4" />'''
assert OLD_SS1 in text, "ss1 anchor missing"
text = text.replace(OLD_SS1, NEW_SS1, 1)
print("OK: ScreenshotSolarSystem")

# 4) ScreenshotTransfer: straight line instead of Bezier
OLD_SS2 = '''    {/* Dashed Bezier arc — planned transfer */}
    <path
      d="M 255 120 C 320 70, 230 60, 180 210"
      stroke="#ffb84d"
      strokeWidth="1.5"
      fill="none"
      strokeDasharray="5 5"
    />'''
NEW_SS2 = '''    {/* Dashed straight-line transfer — matches the in-game render */}
    <line
      x1="255" y1="120" x2="180" y2="210"
      stroke="#ffb84d"
      strokeWidth="1.5"
      strokeDasharray="5 5"
    />'''
assert OLD_SS2 in text, "ss2 anchor missing"
text = text.replace(OLD_SS2, NEW_SS2, 1)
print("OK: ScreenshotTransfer")

# 5) Soften "burn out, flip, burn back" copy — true mechanically but
#    visually the player now sees straight lines.
OLD_PROSE = '''          <p>
            Orbital is a real-time strategy game played across the inner planets,
            the asteroid belt, and the gas giants. Ships move under continuous
            torch acceleration — burn out, flip, burn back — so every transfer
            commits you to a flight path and a travel time you can’t take
            back.
          </p>'''
NEW_PROSE = '''          <p>
            Orbital is a real-time strategy game played across the inner planets,
            the asteroid belt, and the gas giants. Ships ride a continuous-thrust
            torch from origin to target — every transfer commits you to a
            flight time and a fuel cost you can’t take back, computed from
            the ship’s engine and the distance to the rendezvous.
          </p>'''
assert OLD_PROSE in text, "prose anchor missing"
text = text.replace(OLD_PROSE, NEW_PROSE, 1)
print("OK: torch prose")

p.write_text(text, encoding="utf-8")
print("\nLanding.tsx updated.")
