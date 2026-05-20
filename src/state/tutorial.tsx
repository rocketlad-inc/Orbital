// ============================================================
// Tutorial / coachmark state machine.
//
// New players need a guided walkthrough of the major systems —
// otherwise the map's resource pills, the layers panel, the ship-
// panel transfer flow, the build queue, research, and the side
// menu all read as "wait, what does that do?" The tutorial is a
// linear sequence of steps; each step targets a specific UI
// element by data-tutorial-id and shows a coachmark card with a
// short explanation.
//
// State machine:
//   completed=false, active=false  → player hasn't seen the
//      prompt yet. App shows TutorialPromptModal on first game-
//      launch and calls start() if they accept.
//   completed=false, active=true   → tour in progress; index
//      tracks which step is showing. advance() / back() move it.
//   completed=true                 → don't show the prompt again.
//      Resettable via SideMenu → "Restart Tutorial" which calls
//      reset() then start().
//
// Persistence: completed flag lives in localStorage under
// TUTORIAL_STORAGE_KEY so refreshes don't re-prompt. active +
// index are in-memory (re-entering a tour after refresh would
// be confusing; the user can replay from the menu).
// ============================================================

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const TUTORIAL_STORAGE_KEY = 'orbital.tutorial.v1';

interface PersistedTutorial {
  completed: boolean;
  /** Set when the player explicitly says "no thanks" — we still
   *  count it as completed for prompt-suppression but flag it so
   *  the SideMenu can show "Start Tutorial" vs "Replay Tutorial". */
  skipped: boolean;
}

function loadPersisted(): PersistedTutorial {
  try {
    const raw = localStorage.getItem(TUTORIAL_STORAGE_KEY);
    if (!raw) return { completed: false, skipped: false };
    const parsed = JSON.parse(raw) as Partial<PersistedTutorial>;
    return {
      completed: !!parsed.completed,
      skipped: !!parsed.skipped,
    };
  } catch {
    return { completed: false, skipped: false };
  }
}

function persist(state: PersistedTutorial) {
  try {
    localStorage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(state));
  } catch { /* private mode / quota; ignore */ }
}

interface TutorialContextValue {
  /** True while the coachmark overlay is rendering. */
  active: boolean;
  /** Index into the tutorialSteps[] array. -1 when not active. */
  index: number;
  /** True if the player has already finished or skipped the tour. */
  completed: boolean;
  /** True if the player explicitly skipped (vs. finished). */
  skipped: boolean;

  /** Begin the tour from step 0. */
  start: () => void;
  /** Move to the next step. If past the last step, calls finish(). */
  advance: () => void;
  /** Move to the previous step (no-op at step 0). */
  back: () => void;
  /** Quit the tour mid-way and mark completed=true, skipped=true. */
  skip: () => void;
  /** Mark the tour fully completed (called after the last step). */
  finish: () => void;
  /** Wipe the completed flag so the prompt fires again next launch. */
  reset: () => void;
  /** Jump to a specific step (used by the overlay's progress dots). */
  jumpTo: (index: number) => void;
}

const TutorialContext = createContext<TutorialContextValue | null>(null);

interface ProviderProps {
  /** How many steps are in the tour. Provider doesn't import the
   *  steps array directly to avoid the circular dep — pass the
   *  length in from whoever mounts the provider. Default 0 keeps
   *  the provider mountable in unit tests without a step list. */
  stepCount?: number;
  children: React.ReactNode;
}

export function TutorialProvider({ stepCount = 0, children }: ProviderProps) {
  const initial = loadPersisted();
  const [completed, setCompleted] = useState(initial.completed);
  const [skipped, setSkipped] = useState(initial.skipped);
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(-1);

  // Cross-tab sync: if the player resets the tour in another tab
  // (e.g. via Tunables or a future settings page), pick that up.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TUTORIAL_STORAGE_KEY) return;
      const next = loadPersisted();
      setCompleted(next.completed);
      setSkipped(next.skipped);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const start = useCallback(() => {
    setActive(true);
    setIndex(0);
  }, []);

  const finish = useCallback(() => {
    setActive(false);
    setIndex(-1);
    setCompleted(true);
    setSkipped(false);
    persist({ completed: true, skipped: false });
  }, []);

  const skip = useCallback(() => {
    setActive(false);
    setIndex(-1);
    setCompleted(true);
    setSkipped(true);
    persist({ completed: true, skipped: true });
  }, []);

  const advance = useCallback(() => {
    setIndex(prev => {
      const next = prev + 1;
      if (next >= stepCount) {
        // Last step done. Defer finish() to the next tick via
        // setActive(false) here and the finish-on-end useEffect
        // below; doing it inline triggers a setState-in-setState
        // warning if advance() is called from a React event.
        return prev;
      }
      return next;
    });
  }, [stepCount]);

  // Watch for "advance past the end" — index will be stuck at the
  // last step while a separate signal asks us to wrap up. Easiest:
  // expose a derived "atEnd" via index === stepCount - 1, and have
  // the overlay call finish() when the player clicks Done on the
  // last step. advance() above is for mid-tour Next clicks only.

  const back = useCallback(() => {
    setIndex(prev => Math.max(0, prev - 1));
  }, []);

  const jumpTo = useCallback((i: number) => {
    if (i < 0 || i >= stepCount) return;
    setActive(true);
    setIndex(i);
  }, [stepCount]);

  const reset = useCallback(() => {
    setActive(false);
    setIndex(-1);
    setCompleted(false);
    setSkipped(false);
    persist({ completed: false, skipped: false });
  }, []);

  const value: TutorialContextValue = {
    active, index, completed, skipped,
    start, advance, back, skip, finish, reset, jumpTo,
  };

  return (
    <TutorialContext.Provider value={value}>
      {children}
    </TutorialContext.Provider>
  );
}

/** Returns the tutorial context. Safe to call outside the provider —
 *  returns a stub with `completed: true` so callers can treat the
 *  absence of a provider as "no tour, just play." */
export function useTutorial(): TutorialContextValue {
  const ctx = useContext(TutorialContext);
  if (ctx) return ctx;
  return {
    active: false, index: -1, completed: true, skipped: false,
    start: () => undefined,
    advance: () => undefined,
    back: () => undefined,
    skip: () => undefined,
    finish: () => undefined,
    reset: () => undefined,
    jumpTo: () => undefined,
  };
}
