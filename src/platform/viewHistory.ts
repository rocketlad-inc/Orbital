// ============================================================
// Browser history for the three places a signed-in player can be:
// the landing page, the lobby, and a game.
//
// Every one of them is served at "/" (wrangler.jsonc run_worker_first
// keeps "/" on the SPA), so the address bar cannot tell them apart and
// Back used to do nothing (playtest 2026-10-24, D7). Instead each history
// entry carries the view in history.state:
//
//   { orbitalView: 'landing' | 'lobby' | 'game', orbitalRoom?, orbitalIdx }
//
// The app keeps deciding where the player is exactly as before (launch
// routing, Enter room, Leave game...). syncView() is called with the view
// the app is NOW showing and makes history agree:
//
//   * the first time in a page load, the current entry becomes the
//     landing page and the real view is pushed on top of it, so Back from
//     the lobby lands on the home page and Back from a game on the lobby;
//   * a move to the entry just below this one (Leave game -> the lobby we
//     came from) is a history.back(), so the stack never fills with
//     copies and Forward still works;
//   * any other move pushes a new entry.
//
// On popstate the app reads viewOf(history.state) and shows that view;
// syncView() then finds history already agrees and does nothing.
//
// Entries other code pushes (the landing's own tab paths, the Android
// back-button guard) are left alone; the landing copies the tag forward.
// ============================================================

export type AppView =
  | { view: 'landing' }
  | { view: 'lobby' }
  | { view: 'game'; roomId: string };

type Tagged = { orbitalView?: string; orbitalRoom?: string | null; orbitalIdx?: number };

/** The view an entry's state names, or null for an entry we did not tag. */
export function viewOf(state: unknown): AppView | null {
  const s = (state ?? null) as Tagged | null;
  if (!s || typeof s !== 'object') return null;
  if (s.orbitalView === 'landing') return { view: 'landing' };
  if (s.orbitalView === 'lobby') return { view: 'lobby' };
  if (s.orbitalView === 'game' && typeof s.orbitalRoom === 'string' && s.orbitalRoom) {
    return { view: 'game', roomId: s.orbitalRoom };
  }
  return null;
}

export function sameView(a: AppView | null, b: AppView | null): boolean {
  if (!a || !b || a.view !== b.view) return false;
  return a.view !== 'game' || a.roomId === (b as { roomId: string }).roomId;
}

function stateFor(v: AppView, idx: number, base?: unknown): Tagged & Record<string, unknown> {
  const keep = base && typeof base === 'object' ? { ...(base as Record<string, unknown>) } : {};
  return {
    ...keep,
    orbitalView: v.view,
    orbitalRoom: v.view === 'game' ? v.roomId : null,
    orbitalIdx: idx,
  };
}

/** What this page load has pushed, by orbitalIdx. Lost on reload, which
 *  only means the next move pushes instead of stepping back. */
let stack: AppView[] = [];
let initialized = false;
let lastIdx = 0;

/** For tests. */
export function resetViewHistory(): void {
  stack = [];
  initialized = false;
  lastIdx = 0;
}

/** Lobby and game live at "/"; the landing keeps whatever path it is on. */
function pathFor(v: AppView, loc: Location): string {
  const path = v.view === 'landing' ? loc.pathname : '/';
  return `${path}${loc.search}${loc.hash}`;
}

/**
 * Make history agree with the view on screen (see the header). Never
 * throws: a browser without history just keeps the old behaviour.
 */
export function syncView(
  want: AppView,
  h: History = window.history,
  loc: Location = window.location,
): void {
  try {
    const st = h.state as Tagged | null;
    const cur = viewOf(st);
    const curIdx = typeof st?.orbitalIdx === 'number' ? st.orbitalIdx : null;
    if (cur && sameView(cur, want)) {
      initialized = true;
      if (curIdx != null) { lastIdx = curIdx; stack[curIdx] = want; }
      return;
    }
    if (!initialized && !cur) {
      // First sight of this tab: the entry the player arrived on is the
      // home page, and wherever launch put them sits on top of it.
      initialized = true;
      stack = [{ view: 'landing' }];
      lastIdx = 0;
      h.replaceState(stateFor({ view: 'landing' }, 0, st), '');
      if (want.view === 'landing') return;
    }
    initialized = true;
    const idx = curIdx ?? lastIdx;
    if (idx > 0 && sameView(stack[idx - 1] ?? null, want)) {
      lastIdx = idx - 1;
      h.back();
      return;
    }
    const next = idx + 1;
    stack.length = next;
    stack[next] = want;
    lastIdx = next;
    h.pushState(stateFor(want, next), '', pathFor(want, loc));
  } catch { /* history unavailable: Back stays a no-op, as before */ }
}
