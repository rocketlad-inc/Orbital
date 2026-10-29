// Per-page title and description for the landing pages. Landing.tsx sets
// them in the browser; scripts/prerender-pages.mjs writes them into each
// page's static HTML. The answer pages carry their own (answerPages.ts).

export type DocTab = 'about' | 'howto' | 'changelog' | 'privacy' | 'press' | 'credits';

/** The URL each page lives at. */
export const DOC_PATH: Record<DocTab, string> = {
  about: '/',
  howto: '/how-to-play',
  changelog: '/changelog',
  privacy: '/privacy',
  press: '/press',
  credits: '/credits',
};

/** Per-page title and description (search results and browser tabs). */
export const PAGE_META: Record<DocTab, { title: string; description: string }> = {
  about: {
    title: 'Orbital — Free Real-Time Space Strategy Game in Your Browser',
    description: 'A free multiplayer space strategy game set across the real solar system. Two to ten players, a clock that keeps running while you’re offline, and three ways to win.',
  },
  howto: {
    title: 'How to Play Orbital — Space Strategy Guide for New Commanders',
    description: 'Learn Orbital in minutes: ticks, fleets and flight, settling and terraforming worlds, combat, the Senate, and the three ways to win.',
  },
  changelog: {
    title: 'Orbital Changelog — Every Update, Newest First',
    description: 'Every change to Orbital, the free real-time space strategy game, written in plain language, newest first.',
  },
  press: {
    title: 'Orbital Press Kit — Facts, Screenshots, Clips and Logos',
    description: 'Everything for writing about Orbital: the fact sheet, descriptions, full-size screenshots, looping clips, logos and key art.',
  },
  privacy: {
    title: 'Privacy Policy — Orbital',
    description: 'What Orbital collects, why, and how to have it deleted.',
  },
  credits: {
    title: 'Credits — Orbital',
    description: 'The people and open-source work behind Orbital, including the captain portraits from the Naev project.',
  },
};
