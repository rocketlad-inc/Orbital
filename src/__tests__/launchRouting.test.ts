import fs from 'fs';
import path from 'path';

// ============================================================
// Launch routing runs once per sign-in, not once per profile save.
//
// Playtester report (Franz): "Selecting a settlement/station icon in
// the Hangar opens the last played game." The Hangar saves a colony or
// station style, then calls AuthContext.refresh(), which hands back a
// NEW user object. App's launch effect was keyed on that object, so
// every save re-ran launch from the Profile tab: the lobby blanked
// (launchResolved=false) and, with Auto-load on, the game opened in
// its place. Redeeming a gift and the Stripe return poll hit it too.
//
// App.tsx imports the whole renderer, so this pins the dependency in
// the source rather than mounting the shell.
// ============================================================

const src = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');

/** The useEffect body that fetches /api/users/me/rooms, through its deps. */
function launchEffect(): { body: string; deps: string } {
  const at = src.indexOf("'/api/users/me/rooms'");
  expect(at).toBeGreaterThan(0);
  const start = src.lastIndexOf('useEffect(() => {', at);
  const close = /\n {2}\}, \[([^\]]*)\]\);/g;
  close.lastIndex = at;
  const m = close.exec(src);
  expect(start).toBeGreaterThan(0);
  expect(m).not.toBeNull();
  return { body: src.slice(start, m!.index), deps: m![1].trim() };
}

describe('launch routing', () => {
  it('is keyed on the account id, so a refreshed user object does not re-run it', () => {
    const { deps } = launchEffect();
    expect(deps).toBe('userId');
    expect(src).toMatch(/const userId = user\?\.id \?\? null;/);
  });

  it('does not read the user object inside the effect (it would be stale)', () => {
    const { body } = launchEffect();
    expect(body).not.toMatch(/\buser\b(?!Id)/);
  });

  it('still decides Auto-load and blanks the lobby only inside that effect', () => {
    const { body } = launchEffect();
    expect(body).toMatch(/setLaunchResolved\(false\)/);
    expect(body).toMatch(/autoload/);
    // Nowhere else may blank the lobby: that is what made a save look
    // like a relaunch.
    expect(src.match(/setLaunchResolved\(false\)/g)).toHaveLength(1);
  });
});
