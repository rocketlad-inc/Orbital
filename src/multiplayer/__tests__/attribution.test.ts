// Where a player found the game: the browser capture
// (src/multiplayer/attribution.ts) and the server's cleaning and naming
// (worker/attribution.js). The live signup path was also driven end to
// end against a local worker when this landed.
import { captureAttribution, attributionForSignup } from '../attribution';
// @ts-ignore — plain JS worker module
import { readAttribution, sourceFromReferrer, cleanTag } from '../../../worker/attribution.js';

function visit(url: string, referrer = '') {
  window.history.replaceState(null, '', url);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
  captureAttribution();
}

beforeEach(() => window.localStorage.clear());

describe('browser capture', () => {
  it('keeps our link tag and the referring site, then tidies the tag out of the address bar', () => {
    visit('/?from=r-4xgaming&utm_source=reddit', 'https://www.reddit.com/');
    const a = attributionForSignup()!;
    expect(a.from).toBe('r-4xgaming');
    expect(a.utm_source).toBe('reddit');
    expect(a.referrer).toBe('www.reddit.com');
    expect(window.location.search).toBe('');
  });

  it('leaves a game invite in the URL for the lobby, and notes it', () => {
    visit('/?invite=ABC123&from=discord-pbbg');
    expect(window.location.search).toBe('?invite=ABC123');
    expect(attributionForSignup()!.invite).toBe(true);
  });

  it('first informative visit wins; a later one cannot overwrite it', () => {
    visit('/?from=r-neptunespride');
    visit('/?from=bsky-screenshotsaturday');
    expect(attributionForSignup()!.from).toBe('r-neptunespride');
  });

  it('a typed-address first visit is upgraded by a later tagged one', () => {
    visit('/');
    visit('/?from=r-4xgaming');
    expect(attributionForSignup()!.from).toBe('r-4xgaming');
  });

  it('ignores our own site as a referrer and names the Android app', () => {
    visit('/', `${window.location.origin}/press`);
    expect(attributionForSignup()!.referrer).toBeUndefined();
    window.localStorage.clear();
    visit('/', 'android-app://com.orbitalempire.app/');
    expect(attributionForSignup()!.referrer).toBe('android-app');
  });
});

describe('server cleaning and naming', () => {
  it('prefers our tag, then utm, then invite, then the referrer, else direct', () => {
    expect(readAttribution({ from: 'R-4XGaming', referrer: 'www.reddit.com' })).toMatchObject({ source: 'r-4xgaming', referrer: 'reddit' });
    expect(readAttribution({ utm_source: 'Newsletter', utm_campaign: 'Oct Launch' })).toMatchObject({ source: 'newsletter', campaign: 'oct-launch' });
    expect(readAttribution({ invite: true, referrer: 'discord.com' })).toMatchObject({ source: 'invite', referrer: 'discord' });
    expect(readAttribution({ referrer: 'news.ycombinator.com' })!.source).toBe('hackernews');
    expect(readAttribution({ landing: '/' })!.source).toBe('direct');
  });

  it('stores nothing for a client that sent nothing, rather than guessing', () => {
    expect(readAttribution(undefined)).toBeNull();
    expect(readAttribution('reddit')).toBeNull();
  });

  it('cuts hostile input to a short plain token', () => {
    const t = cleanTag('<script>alert(1)</script> DROP TABLE users;--');
    expect(t).toMatch(/^[a-z0-9._-]+$/);
    expect(t!.length).toBeLessThanOrEqual(40);
    expect(readAttribution({ first_seen_ms: 'soon', landing: 123 })).toMatchObject({ first_seen_ms: null, landing: null });
  });

  it('names common referrers and leaves unknown hosts readable', () => {
    expect(sourceFromReferrer('old.reddit.com')).toBe('reddit');
    expect(sourceFromReferrer('www.google.co.uk')).toBe('google');
    expect(sourceFromReferrer('t.co')).toBe('x');
    expect(sourceFromReferrer('bsky.app')).toBe('bluesky');
    expect(sourceFromReferrer('play.google.com')).toBe('google-play');
    expect(sourceFromReferrer('www.pbbg.com')).toBe('pbbg.com');
  });
});
