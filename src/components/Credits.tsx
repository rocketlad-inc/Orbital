// ============================================================
// Credits — /credits. Third-party art the game ships, and the terms it
// ships under.
//
// THE PORTRAIT LIST IS THE LICENCE. The captain portraits are CC-BY 3.0
// (labelled so in Naev's gfx/ARTWORK_LICENSE.yaml) and derive from Ingo
// Ruhnke's CC-BY-SA 3.0 portraits, so they are credited AND offered here
// under CC-BY-SA 3.0, the stricter of the two. Every file in
// public/portraits must have a row below; scripts/import-portraits.js
// says the same from the other end.
//
// Faction portraits that carry Naev's own emblems (licensed separately)
// were left out of the import on purpose.
// ============================================================

import React from 'react';

const AUTHORS: Record<string, string> = {
  N: 'Nihilos',
  D: 'The Diligent Circle, based on components by Nihilos',
  V: 'Viktor Hahn, based on components by Nihilos',
};

/** [our id, file in Naev's gfx/portraits/, author key] */
const PORTRAITS: Array<[string, string, string]> = [
  ['p1', 'dvaered/dv_civilian_m1.webp', 'D'],
  ['p2', 'neutral/scientist3.webp', 'N'],
  ['p3', 'dvaered/dv_civilian_f5.webp', 'D'],
  ['p4', 'neutral/male11.webp', 'D'],
  ['p5', 'neutral/scientist2.webp', 'N'],
  ['p6', 'neutral/female11.webp', 'D'],
  ['p7', 'neutral/unique/unfamiliarman.webp', 'D'],
  ['p8', 'dvaered/dv_civilian_m2.webp', 'D'],
  ['p9', 'neutral/unique/mia.webp', 'N'],
  ['p10', 'neutral/female13.webp', 'D'],
  ['p11', 'sirius/unique/strangeman.webp', 'D'],
  ['p12', 'neutral/unique/rebina_casual.webp', 'N'],
  ['p13', 'neutral/male5.webp', 'D'],
  ['p14', 'neutral/female2.webp', 'D'],
  ['p15', 'sirius/sirius_shaira_m5.webp', 'D'],
  ['p16', 'sirius/sirius_shaira_f1.webp', 'D'],
  ['p17', 'neutral/cyborg3.webp', 'N'],
  ['p18', 'pirate/pirate10.webp', 'D'],
  ['p19', 'neutral/male3.webp', 'D'],
  ['p20', 'pirate/pirate12.webp', 'D'],
  ['p21', 'sirius/sirius_shaira_m1.webp', 'D'],
  ['p22', 'neutral/female7.webp', 'D'],
  ['p23', 'pirate/pirate7.webp', 'D'],
  ['p24', 'neutral/unique/hunter.webp', 'N'],
  ['p25', 'zalek/unique/mensing.webp', 'V'],
  ['p26', 'neutral/female1.webp', 'N'],
  ['p27', 'dvaered/dv_civilian_f4.webp', 'D'],
  ['p28', 'sirius/unique/draga.webp', 'D'],
  ['p29', 'dvaered/dv_civilian_m10.webp', 'D'],
  ['p30', 'neutral/unique/cynthia_father.webp', 'D'],
  ['p31', 'dvaered/dv_civilian_f10.webp', 'D'],
  ['p32', 'neutral/male9.webp', 'D'],
  ['p33', 'neutral/unique/dealer.webp', 'D'],
  ['p34', 'pirate/pirate3.webp', 'N'],
  ['p35', 'pirate/pirate9.webp', 'D'],
  ['p36', 'neutral/male10.webp', 'D'],
  ['p37', 'zalek/unique/student.webp', 'V'],
  ['p38', 'neutral/unique/drunkard.webp', 'N'],
  ['p39', 'sirius/sirius_shaira_f5.webp', 'D'],
  ['p40', 'neutral/unique/flintley.webp', 'N'],
  ['p41', 'neutral/unique/shifty_merchant.webp', 'D'],
  ['p42', 'neutral/cyborg1.webp', 'N'],
  ['p43', 'sirius/sirius_shaira_m2.webp', 'D'],
  ['p44', 'neutral/unique/reynir.webp', 'N'],
  ['p45', 'sirius/sirius_shaira_f2.webp', 'D'],
  ['p46', 'neutral/male1.webp', 'N'],
  ['p47', 'dvaered/dv_civilian_f9.webp', 'D'],
  ['p48', 'pirate/pirate5.webp', 'D'],
  ['p49', 'soromid/unique/chelsea.webp', 'D'],
  ['p50', 'sirius/unique/shaman.webp', 'D'],
  ['p51', 'neutral/female3.webp', 'D'],
  ['p52', 'neutral/unique/jorek.webp', 'N'],
  ['p53', 'pirate/pirate14.webp', 'D'],
  ['p54', 'dvaered/dv_civilian_f3.webp', 'D'],
  ['p55', 'neutral/male7.webp', 'D'],
  ['p56', 'dvaered/dv_civilian_f2.webp', 'N'],
  ['p57', 'dvaered/dv_civilian_m6.webp', 'D'],
  ['p58', 'neutral/female9.webp', 'D'],
  ['p59', 'neutral/unique/cynthia.webp', 'D'],
  ['p60', 'pirate/pirate2.webp', 'N'],
  ['p61', 'dvaered/dv_civilian_m3.webp', 'D'],
  ['p62', 'pirate/pirate_militia1.webp', 'N'],
  ['p63', 'zalek/unique/geller.webp', 'D'],
  ['p64', 'neutral/unique/paddy.webp', 'D'],
  ['p65', 'dvaered/dv_civilian_m5.webp', 'D'],
  ['p66', 'sirius/sirius_shaira_m4.webp', 'D'],
  ['p67', 'neutral/barman.webp', 'N'],
  ['p68', 'dvaered/dv_civilian_f11.webp', 'D'],
  ['p69', 'neutral/female12.webp', 'D'],
  ['p70', 'pirate/pirate6.webp', 'D'],
  ['p71', 'neutral/miner1.webp', 'N'],
  ['p72', 'neutral/male12.webp', 'D'],
  ['p73', 'neutral/cyborg2.webp', 'N'],
  ['p74', 'neutral/male13.webp', 'D'],
  ['p75', 'pirate/pirate4.webp', 'N'],
  ['p76', 'neutral/unique/rebina.webp', 'N'],
  ['p77', 'neutral/unique/neil.webp', 'N'],
  ['p78', 'neutral/unique/aristocrat.webp', 'N'],
  ['p79', 'dvaered/dv_civilian_m11.webp', 'D'],
  ['p80', 'neutral/unique/laidback.webp', 'D'],
  ['p81', 'dvaered/dv_civilian_m8.webp', 'D'],
  ['p82', 'neutral/male2.webp', 'D'],
  ['p83', 'neutral/thief2.webp', 'N'],
  ['p84', 'neutral/scientist.webp', 'N'],
  ['p85', 'dvaered/dv_civilian_f6.webp', 'D'],
  ['p86', 'dvaered/dv_civilian_m7.webp', 'D'],
  ['p87', 'neutral/female5.webp', 'D'],
  ['p88', 'pirate/pirate_militia2.webp', 'N'],
  ['p89', 'neutral/unique/michal.webp', 'D'],
  ['p90', 'neutral/miner2.webp', 'N'],
  ['p91', 'neutral/unique/reynir2.webp', 'N'],
  ['p92', "dvaered/unique/ka'def.webp", 'N'],
  ['p93', 'neutral/female6.webp', 'D'],
  ['p94', 'neutral/unique/arnoldsmith.webp', 'D'],
  ['p95', 'neutral/thief1.webp', 'N'],
  ['p96', 'neutral/male8.webp', 'D'],
  ['p97', 'neutral/male6.webp', 'D'],
  ['p98', 'neutral/female8.webp', 'D'],
  ['p99', 'sirius/sirius_shaira_f4.webp', 'D'],
  ['p100', 'sirius/sirius_shaira_f3.webp', 'D'],
  ['p101', 'dvaered/dv_civilian_f8.webp', 'D'],
  ['p102', 'pirate/pirate13.webp', 'D'],
  ['p103', 'dvaered/dv_civilian_f1.webp', 'N'],
  ['p104', 'pirate/pirate1.webp', 'N'],
  ['p105', 'neutral/unique/nexus_agent.webp', 'D'],
  ['p106', 'neutral/unique/oldwoman.webp', 'N'],
  ['p107', 'dvaered/dv_civilian_m4.webp', 'D'],
  ['p108', 'neutral/unique/fakesister.webp', 'D'],
  ['p109', 'sirius/sirius_shaira_m3.webp', 'D'],
  ['p110', 'neutral/thief3.webp', 'N'],
  ['p111', 'neutral/female10.webp', 'D'],
  ['p112', 'neutral/male4.webp', 'D'],
  ['p113', 'pirate/pirate11.webp', 'D'],
  ['p114', 'neutral/thief4.webp', 'D'],
  ['p115', 'neutral/female4.webp', 'D'],
  ['p116', 'dvaered/dv_civilian_m9.webp', 'D'],
  ['p117', 'neutral/unique/youngbusinessman.webp', 'N'],
  ['p118', 'neutral/unique/middleaged.webp', 'D'],
  ['p119', 'pirate/pirate8.webp', 'D'],
  ['p120', 'neutral/unique/youngbusinessman2.webp', 'N'],
  ['p121', 'zalek/unique/logan.webp', 'D'],
  ['p122', 'dvaered/dv_civilian_f7.webp', 'D'],
];

const NAEV_ART = 'https://github.com/naev/naev-artwork-production/tree/main/gfx/portraits';

export const Credits: React.FC = () => (
  <section className="landing-doc">
    <h1 className="doc-title">Credits</h1>
    <p className="doc-lede">
      Orbital&rsquo;s map, ships and interface are drawn by the game&rsquo;s own code. The
      captain portraits and fonts are other people&rsquo;s work, used under the licences below.
    </p>

    <h2>Captain portraits</h2>
    <p>
      From the open-source space game <a className="doc-link" href="https://naev.org">Naev</a>:
      portraits by <strong>Nihilos</strong>{' '}
      (<a className="doc-link" href="https://opengameart.org/content/portraits-for-naev">Portraits for Naev</a>),
      extended by <strong>The Diligent Circle</strong> and <strong>Viktor Hahn</strong> from
      Nihilos&rsquo;s components, which build on portraits by <strong>Ingo Ruhnke (Grumbel)</strong>.
      Source: <a className="doc-link" href={NAEV_ART}>naev-artwork-production</a>.
    </p>
    <p>
      Naev lists these portraits as{' '}
      <a className="doc-link" href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>; because
      they build on CC BY-SA work, Orbital treats them as{' '}
      <a className="doc-link" href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>.
      <strong> Changes:</strong> cropped to a square and resized to 128&times;128. The resized
      files are at <code>orbital-empire.com/portraits/p1.webp</code> through{' '}
      <code>p122.webp</code>, and are themselves available under CC BY-SA 3.0.
      No endorsement by the artists or the Naev project is implied.
    </p>
    <details className="credits-list">
      <summary>Every portrait and its source file ({PORTRAITS.length})</summary>
      <ul>
        {PORTRAITS.map(([id, file, who]) => (
          <li key={id}><code>{id}</code> &larr; <code>{file}</code> &middot; {AUTHORS[who]}</li>
        ))}
      </ul>
    </details>

    <h2>Fonts</h2>
    <p>
      Audiowide (Astigmatic), Chakra Petch (Cadson Demak) and Chivo Mono (Omnibus-Type), served by
      Google Fonts under the <a className="doc-link" href="https://openfontlicense.org">SIL Open Font License 1.1</a>.
    </p>
  </section>
);
