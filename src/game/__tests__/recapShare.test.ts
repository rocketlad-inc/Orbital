/**
 * @jest-environment node
 */
// WHAT A BATTLE RECAP LOOKS LIKE WHERE PEOPLE PASTE IT (worker/recapShare.js).
//
// A recap link used to unfurl as the site's generic advert. Now it names
// the battle, its sides, its winner and its toll, with a picture of the
// world; and when a battle closes, the game's Discord feed gets the link.

import { CompressionStream as NodeCompressionStream } from 'stream/web';
import { Blob as NodeBlob } from 'buffer';
import { recapMeta, renderRecapCard, publishReplay, RECAP_PAGE_RE, RECAP_CARD_RE } from '../../../worker/recapShare.js';

// The Workers runtime has CompressionStream (encodePng deflates with it);
// this jest Node only has it under stream/web.
if (!(globalThis as { CompressionStream?: unknown }).CompressionStream) {
  (globalThis as { CompressionStream?: unknown }).CompressionStream = NodeCompressionStream;
}
if (!(globalThis as { Blob?: unknown }).Blob) (globalThis as { Blob?: unknown }).Blob = NodeBlob;
if (!(globalThis as { Response?: unknown }).Response) {
  // encodePng drains the compressed stream through a Response.
  (globalThis as { Response?: unknown }).Response = class {
    private s: ReadableStream;
    constructor(s: ReadableStream) { this.s = s; }
    async arrayBuffer() {
      const chunks: Uint8Array[] = [];
      const r = this.s.getReader();
      for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out.buffer;
    }
  };
}

const mars = {
  token: 'dBF80GoSx1LbnLIoRp4T', gameName: 'Peace Zone', bodyName: 'Mars',
  body: { id: 'g:mars', type: 'terrestrial', color: '#c1440e', orbit_radius: 300, yield_metal: 4, terraformed_at_tick: 90 },
  terraformed: true, startTick: 115, endTick: 169, turns: 55, shots: 468, shipsLost: 45,
  sides: [
    { name: 'Frowny Face ENEMIES >:(', color: '#e0457b', committed: 33, lost: 25, kills: 5 },
    { name: 'The UTEF', color: '#ffd23f', committed: 22, lost: 19, kills: 30 },
  ],
  victor: { name: 'The UTEF', color: '#ffd23f' },
  ace: { ship: 'LSS Firetail', captain: 'Vex Orlan', kills: 7, faction: 'The UTEF', color: '#ffd23f' },
};

describe('the link preview text', () => {
  it('names the battle, the winner and the toll', () => {
    const m = recapMeta(mars);
    expect(m.title).toBe('Battle of Mars: The UTEF wins');
    expect(m.description).toContain('The UTEF won the battle of Mars');
    expect(m.description).toContain('2 empires, 45 ships lost over 55 turns');
    expect(m.description).toContain('Captain Vex Orlan of the LSS Firetail took 7');
    expect(m.alt).toContain('Mars as it looked during the battle');
  });

  it('says so when nobody won, and counts in the singular', () => {
    const m = recapMeta({ ...mars, victor: null, shipsLost: 1, turns: 1, ace: null, sides: mars.sides.slice(0, 1) });
    expect(m.title).toBe('Battle of Mars');
    expect(m.description).toContain('No clear victor at Mars');
    expect(m.description).toContain('1 empire, 1 ship lost over 1 turn');
    expect(m.description).not.toContain('Captain');
  });
});

describe('the card', () => {
  // A 1200x630 PNG drawn and deflated in plain JS: quick alone, but slow
  // when the whole suite shares the CPU.
  jest.setTimeout(60_000);

  it('is a 1200x630 PNG, with or without the planet', async () => {
    for (const planet of [null, { w: 4, h: 4, data: new Uint8Array(64).fill(200) }]) {
      const png: Uint8Array = await renderRecapCard(mars, planet);
      expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const view = new DataView(png.buffer, png.byteOffset);
      expect(view.getUint32(16)).toBe(1200);
      expect(view.getUint32(20)).toBe(630);
    }
  });

  it('copes with many sides and long names', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `The Very Long Empire Name Number ${i}`, color: '#88aacc', committed: 5, lost: i % 5, kills: 1 }));
    const png = await renderRecapCard({ ...mars, sides: many, bodyName: 'The Kuiper Belt Deep Field' }, null);
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe('routes', () => {
  it('the page and the card have their own paths', () => {
    expect(RECAP_PAGE_RE.exec('/recap/dBF80GoSx1LbnLIoRp4T')?.[1]).toBe('dBF80GoSx1LbnLIoRp4T');
    expect(RECAP_PAGE_RE.test('/recap/dBF80GoSx1LbnLIoRp4T/card.png')).toBe(false);
    expect(RECAP_CARD_RE.exec('/recap/dBF80GoSx1LbnLIoRp4T/card.png')?.[1]).toBe('dBF80GoSx1LbnLIoRp4T');
    expect(RECAP_PAGE_RE.test('/recap/../../etc')).toBe(false);
  });
});

describe('the replay goes to Discord when a battle closes', () => {
  /** A D1 that answers the summary's queries for one battle. */
  function env(shipsLost: number, posts: any[], { cardsOff = false, token = 'tok12345678', feed = 'all' as string | null } = {}) {
    const first = async (sql: string) => {
      if (sql.includes('FROM game_feeds')) return feed ? { game_id: 'g', level: feed } : null;
      if (sql.includes('FROM battle_shares WHERE battle_id')) return token ? { token } : null;
      if (sql.includes('FROM battle_shares s')) {
        return { token, id: 'b1', game_id: 'g', body_id: null, body_name: 'Mars', started_tick: 115, ended_tick: 169,
          last_fire_tick: 169, shots: 468, ships_lost: shipsLost, settlements_lost: 0, victor_faction_id: 'f1', game_name: 'Peace Zone' };
      }
      return null;
    };
    const all = async () => ({ results: [{ faction_id: 'f1', name: 'The UTEF', color: '#ffd23f', committed: 22, lost: 19, kills: 30 }] });
    return {
      DISCORD_BOT_TOKEN: 'x',
      DB: { prepare: (sql: string) => ({ bind: () => ({ first: () => first(sql), all }), first: () => first(sql), all }) },
      __posts: posts,
      __cardsOff: cardsOff,
    };
  }

  beforeEach(() => {
    jest.resetModules();
  });

  it('posts the link, the card picture and the winner', async () => {
    const posts: any[] = [];
    jest.doMock('../../../worker/botSettings.js', () => ({ getSettings: async () => ({}) }), { virtual: false });
    jest.doMock('../../../worker/discord.js', () => ({
      postChannelEmbed: async (_env: unknown, build: (L: string) => object, gameId: string, opts: object) => {
        posts.push({ embed: build('en'), gameId, opts });
        return { posted: true };
      },
    }));
    const { publishReplay: publish } = await import('../../../worker/recapShare.js');
    await publish(env(45, posts), 'g', 'b1');
    expect(posts).toHaveLength(1);
    const { embed, gameId, opts } = posts[0];
    expect(gameId).toBe('g');
    expect(opts).toEqual({ headline: true });
    expect(embed.title).toContain('Battle of Mars: The UTEF wins');
    expect(embed.url).toBe('https://orbital-empire.com/recap/tok12345678?from=discord-replay');
    expect(embed.image.url).toBe('https://orbital-empire.com/recap/tok12345678/card.png');
    expect(embed.description).toContain('[Watch the replay](https://orbital-empire.com/recap/tok12345678?from=discord-replay)');
  });

  it('skips a skirmish, and respects the battle-card switch', async () => {
    const posts: any[] = [];
    jest.doMock('../../../worker/botSettings.js', () => ({ getSettings: async () => ({}) }));
    jest.doMock('../../../worker/discord.js', () => ({ postChannelEmbed: async () => { posts.push(1); return { posted: true }; } }));
    let { publishReplay: publish } = await import('../../../worker/recapShare.js');
    await publish(env(2, posts), 'g', 'b1');
    expect(posts).toHaveLength(0);

    jest.resetModules();
    jest.doMock('../../../worker/botSettings.js', () => ({ getSettings: async () => ({ battle_cards_enabled: false }) }));
    jest.doMock('../../../worker/discord.js', () => ({ postChannelEmbed: async () => { posts.push(1); return { posted: true }; } }));
    ({ publishReplay: publish } = await import('../../../worker/recapShare.js'));
    await publish(env(45, posts), 'g', 'b1');
    expect(posts).toHaveLength(0);
  });

  it('posts nothing, and renders nothing, when the game feed would not take it', async () => {
    const posts: any[] = [];
    const queued: any[] = [];
    jest.doMock('../../../worker/botSettings.js', () => ({ getSettings: async () => ({}) }));
    jest.doMock('../../../worker/discord.js', () => ({ postChannelEmbed: async () => { posts.push(1); return { posted: true }; } }));
    jest.doMock('../../../worker/recapGif.js', () => ({ queueBattleGif: async (...a: unknown[]) => { queued.push(a); return true; } }));
    const { publishReplay: publish } = await import('../../../worker/recapShare.js');
    await publish(env(45, posts, { feed: null }), 'g', 'b1');          // feed never set up
    await publish(env(45, posts, { feed: 'off' }), 'g', 'b1');
    await publish(env(5, posts, { feed: 'headlines' }), 'g', 'b1');    // not a headline (under 10 lost)
    expect(posts).toHaveLength(0);
    expect(queued).toHaveLength(0);
    await publish(env(12, posts, { feed: 'headlines' }), 'g', 'b1');   // a headline
    expect(queued).toHaveLength(1);
  });

  it('hands the post to the GIF renderer when there is one, instead of posting now', async () => {
    const posts: any[] = [];
    const queued: any[] = [];
    jest.doMock('../../../worker/botSettings.js', () => ({ getSettings: async () => ({}) }));
    jest.doMock('../../../worker/discord.js', () => ({ postChannelEmbed: async () => { posts.push(1); return { posted: true }; } }));
    jest.doMock('../../../worker/recapGif.js', () => ({ queueBattleGif: async (...a: unknown[]) => { queued.push(a); return true; } }));
    const { publishReplay: publish } = await import('../../../worker/recapShare.js');
    await publish(env(45, posts), 'g', 'b1');
    expect(posts).toHaveLength(0);
    expect(queued).toEqual([[expect.anything(), 'g', 'b1', 'tok12345678']]);
  });

  it('never throws, whatever breaks', async () => {
    await expect(publishReplay({ DISCORD_BOT_TOKEN: 'x', DB: null } as any, 'g', 'b1')).resolves.toBeUndefined();
  });
});
