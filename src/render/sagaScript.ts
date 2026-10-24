// ============================================================
// The Saga Engine's script, as the film receives it with the match
// summary (worker/saga/engine.js buildScript). The engine decides the
// story; the film (matchMap.ts) plays it: the runtime, the crawl, the
// empires' cards, which scenes the story needs and the words on them,
// the veteran captains, the transmissions and the roll call.
// ============================================================

export interface SagaBeat {
  tick: number;
  kind: string;
  fid: string | null;
  target: string | null;
  plot: string | null;
  /** How much the story needs this scene, on the film's own scale. */
  weight: number;
  kicker: string;
  title: string;
  because: string;
  /** A veteran captain's name, on a captain_lost scene. */
  veteran?: string;
  remaining?: number;
}

export interface SagaVeteran {
  fid: string; name: string; rank: number; bio: string; avatar: string | null;
  tick: number; ship: string | null; world: string | null; days: number; kills: number;
  firstKill: { tick: number; ship: string; world: string | null } | null;
  ledger: string[];
}

export interface SagaScript {
  v: number;
  gameId: string;
  shape: 'hegemony' | 'upset' | 'race';
  overlays: string[];
  mood: 'ember' | 'violet' | 'gold' | 'ice';
  /** Seconds of film. */
  runtime: number;
  crawl: { title: string; titleKind: 'law' | 'made'; credit: string; lines: string[]; seconds: number };
  cast: Array<{ fid: string; role: string; label: string; receipt: string; creed: string; tagline: string; home: string | null }>;
  rollCall: string[];
  plots: Array<{ id: string; kind: string; fids: string[] }>;
  beats: SagaBeat[];
  boosts: { fids: Record<string, number>; pairs: Record<string, number> };
  veterans: SagaVeteran[];
  transmissions: Array<{ tick: number; fid: string; text: string }>;
}

/** The pair key the engine uses for rivalries. */
export const sagaPair = (a: string, b: string) => [a, b].sort().join('|');

/** A captain's portrait file (public/portraits), from its avatar id. */
export function portraitUrl(avatar: string | null | undefined): string | null {
  const id = String(avatar ?? '').trim();
  if (/^p\d+$/.test(id)) return `/portraits/${id}.webp`;
  const legacy = /^a(\d+)$/.exec(id);
  return legacy ? `/portraits/p${legacy[1]}.webp` : null;
}
