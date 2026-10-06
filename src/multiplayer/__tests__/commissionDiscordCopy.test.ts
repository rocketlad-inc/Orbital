/**
 * Every surface that sells the Commission names the Discord perk.
 *
 * Lorne, 2026-10-06: "Make sure Discord bot is clearly outlined anywhere
 * we are selling the commission." The perk is a host's game feed in their
 * own Discord server (worker/gameFeed.js, YOUR OWN SERVER). This fails if
 * a surface is added, or rewritten, without it.
 */
import fs from 'fs';
import path from 'path';
import { COMMISSION_FACTS, COMMISSION_DISCORD } from '../commission';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

test('the one-sentence offer includes it', () => {
  expect(COMMISSION_FACTS).toContain(COMMISSION_DISCORD);
  expect(COMMISSION_DISCORD).toMatch(/Discord/);
  // The rule, not the old "Cosmetic only", which stopped being the whole truth.
  expect(COMMISSION_FACTS).toMatch(/Nothing that changes the game/);
  expect(COMMISSION_FACTS).not.toMatch(/Cosmetic only/i);
});

test.each([
  // [surface, file, what proves the perk is named there]
  ['profile Hangar (buyers and holders)', 'multiplayer/Hangar.tsx', /data-testid="hangar-discord"[\s\S]*data-testid="hangar-discord"/],
  ['end-of-game card', 'multiplayer/CommissionMoments.tsx', /COMMISSION_DISCORD/],
  ['20-hour thank-you card', 'multiplayer/CommissionMoments.tsx', /COMMISSION_FACTS/],
  ['lobby flag picker', 'multiplayer/LobbyView.tsx', /COMMISSION_DISCORD/],
  ['designer preview', 'components/ShipDesigner.tsx', /COMMISSION_DISCORD/],
  ['colony & station style picker', 'multiplayer/SkinPicker.tsx', /COMMISSION_DISCORD/],
  ['after payment', 'multiplayer/CommissionThanks.tsx', /Connect your server/],
  ['the game feed card itself', 'multiplayer/DiscordServerFeed.tsx', /your own server/],
  ['landing page FAQ', 'components/LandingHome.tsx', /Commander’s Commission[^']*Discord/],
])('%s names it', (_name, rel, proof) => {
  expect(src(rel)).toMatch(proof);
});

test('no selling surface still says "Cosmetic only"', () => {
  for (const rel of [
    'multiplayer/Hangar.tsx', 'multiplayer/CommissionMoments.tsx', 'multiplayer/LobbyView.tsx',
    'components/ShipDesigner.tsx', 'multiplayer/SkinPicker.tsx', 'multiplayer/CommissionThanks.tsx',
  ]) {
    expect(src(rel)).not.toMatch(/Cosmetic only/i);
  }
});

test('the search-engine FAQ in the page shell agrees with the landing page', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'index.html'), 'utf8');
  expect(html).toMatch(/Commander’s Commission \(\$10\)[^"]*Discord/);
});
