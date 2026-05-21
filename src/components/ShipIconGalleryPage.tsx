// ============================================================
// ShipIconGalleryPage — visual review surface for ship-icon
// candidates. Renders every (class × variant) combination in a
// labeled grid so the player can pick which ones to include in
// the construction picker.
//
// Reachable via the landing page (?icons) without auth, same
// pattern as TunablesPage / UXGallery.
// ============================================================

import React, { useState } from 'react';
import {
  ShipIconClass, ShipIconVariant, ShipIcon,
  ICON_VARIANT_NAMES, ALL_VARIANTS, DEFAULT_SHIP_ICONS,
} from './ShipIcons';

interface Props {
  onBack: () => void;
}

const CLASSES: ShipIconClass[] = ['corvette', 'frigate', 'destroyer', 'freighter'];

// Faction-color samples so we can preview each candidate against the
// hues it'll actually be rendered with in-game. Mirrors COLORS.neutral
// / COLORS.danger plus a couple of common faction palette picks.
const PREVIEW_COLORS: { label: string; color: string }[] = [
  { label: 'PLAYER (cyan)',  color: '#4ecdc4' },
  { label: 'ENEMY (red)',    color: '#ff5e5e' },
  { label: 'AMBER',          color: '#ffb84d' },
  { label: 'VIOLET',         color: '#ab47bc' },
];

export const ShipIconGalleryPage: React.FC<Props> = ({ onBack }) => {
  // Tracks the currently-spotlit color so the player can flip all
  // icons through their faction palette without re-rendering each
  // tile in every color.
  const [color, setColor] = useState<string>(PREVIEW_COLORS[0].color);
  // Player picks which candidates to keep. Defaults to the existing
  // A/B/C (already shipping). Clicking a tile toggles inclusion.
  const [keep, setKeep] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const cls of CLASSES) {
      s.add(`${cls}:A`);
      s.add(`${cls}:B`);
      s.add(`${cls}:C`);
    }
    return s;
  });

  const toggle = (cls: ShipIconClass, v: ShipIconVariant) => {
    const key = `${cls}:${v}`;
    setKeep(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Build the JSON snippet the player can paste back at us to lock
  // in their picks. Grouped by class.
  const summary = (() => {
    const lines: string[] = ['{'];
    CLASSES.forEach((cls, ci) => {
      const kept = ALL_VARIANTS.filter(v => keep.has(`${cls}:${v}`));
      lines.push(`  "${cls}": [${kept.map(v => `"${v}"`).join(', ')}]${ci < CLASSES.length - 1 ? ',' : ''}`);
    });
    lines.push('}');
    return lines.join('\n');
  })();

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #050810 0%, #0c1218 100%)',
        color: '#d8e4ee',
        fontFamily: "'JetBrains Mono', monospace",
        padding: '20px 28px 60px',
      }}
    >
      <header
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          paddingBottom: 12, marginBottom: 20,
          borderBottom: '1px solid #2a3d50',
        }}
      >
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.16em', color: '#8a9fb3' }}>
            ORBITAL · ICON GALLERY
          </div>
          <h1 style={{ margin: '4px 0 0', fontSize: 22, color: '#ffb84d', letterSpacing: '0.08em' }}>
            Ship Icon Candidates
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: '#8a9fb3', maxWidth: 720 }}>
            A/B/C are the shipping defaults; D/E/F are new proposals. Click any
            tile to toggle inclusion. The summary at the bottom is what to
            paste back when you're done picking.
          </p>
        </div>
        <button
          onClick={onBack}
          style={{
            padding: '6px 14px',
            background: 'transparent', color: '#4ecdc4',
            border: '1px solid #4ecdc4', borderRadius: 4,
            fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.1em', cursor: 'pointer',
          }}
        >← BACK</button>
      </header>

      {/* Color toolbar so the player can preview each icon in the
          color it'll actually render against in-game. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 0', marginBottom: 18, flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 10, letterSpacing: '0.14em', color: '#8a9fb3' }}>
          PREVIEW COLOR
        </span>
        {PREVIEW_COLORS.map(p => (
          <button
            key={p.color}
            onClick={() => setColor(p.color)}
            style={{
              padding: '4px 10px',
              background: color === p.color ? p.color : 'transparent',
              color: color === p.color ? '#0a1018' : p.color,
              border: `1px solid ${p.color}`,
              borderRadius: 3,
              fontFamily: 'inherit', fontSize: 10,
              fontWeight: 600, letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >{p.label}</button>
        ))}
      </div>

      {CLASSES.map(cls => (
        <section key={cls} style={{ marginBottom: 28 }}>
          <h2
            style={{
              fontSize: 11, letterSpacing: '0.18em', color: '#ffb84d',
              borderBottom: '1px dashed #2a3d50', paddingBottom: 6,
              marginBottom: 12,
            }}
          >
            {cls.toUpperCase()}
            <span style={{ marginLeft: 10, color: '#8a9fb3', fontSize: 9 }}>
              · default: {DEFAULT_SHIP_ICONS[cls]} ({ICON_VARIANT_NAMES[cls][DEFAULT_SHIP_ICONS[cls]]})
            </span>
          </h2>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
            }}
          >
            {ALL_VARIANTS.map(v => {
              const isKept = keep.has(`${cls}:${v}`);
              const isNew = v === 'D' || v === 'E' || v === 'F';
              return (
                <button
                  key={v}
                  onClick={() => toggle(cls, v)}
                  style={{
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 6,
                    padding: '14px 8px 10px',
                    background: isKept ? 'rgba(78, 205, 196, 0.06)' : '#0a1018',
                    border: `1px solid ${isKept ? '#4ecdc4' : '#2a3d50'}`,
                    borderRadius: 6,
                    fontFamily: 'inherit', color: '#d8e4ee',
                    cursor: 'pointer', position: 'relative',
                  }}
                >
                  {isNew && (
                    <span
                      style={{
                        position: 'absolute', top: 4, right: 6,
                        fontSize: 8, letterSpacing: '0.1em',
                        padding: '1px 5px', borderRadius: 3,
                        background: '#ffb84d', color: '#0a1018',
                        fontWeight: 700,
                      }}
                    >NEW</span>
                  )}
                  <ShipIcon shipClass={cls} variant={v} size={56} color={color} />
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em' }}>
                    {v} · {ICON_VARIANT_NAMES[cls][v]}
                  </div>
                  <div style={{ fontSize: 9, color: isKept ? '#4ecdc4' : '#8a9fb3', letterSpacing: '0.1em' }}>
                    {isKept ? '✓ INCLUDED' : 'click to include'}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {/* Picks summary — easy to copy back to confirm the keep list. */}
      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 11, letterSpacing: '0.18em', color: '#ffb84d', marginBottom: 8 }}>
          PICKS SUMMARY
        </h2>
        <p style={{ fontSize: 10, color: '#8a9fb3', margin: '0 0 8px' }}>
          Paste this back when you're done picking — I'll wire the picker to
          exactly this set and remove the rest.
        </p>
        <pre
          style={{
            background: '#0a1018', border: '1px solid #2a3d50',
            borderRadius: 4, padding: '12px 14px',
            fontSize: 11, color: '#d8e4ee', whiteSpace: 'pre-wrap',
            fontFamily: "'JetBrains Mono', monospace",
            margin: 0,
          }}
        >{summary}</pre>
      </section>
    </div>
  );
};
