// Types for the plain-JS module the WORKER also imports. Same split as
// src/physics/rendezvous.js/.d.ts: the implementation has to be .js so
// esbuild can pull it into the worker bundle, and the client still gets
// full typing from here.
export declare const NAME_KINDS: readonly ['ship', 'captain', 'station', 'city'];
export type NameKind = (typeof NAME_KINDS)[number];
export type NamePools = Record<NameKind, string[]>;

export declare const NAME_MAX_LEN: number;
export declare const POOL_MAX: number;
export declare const EMPTY_POOLS: NamePools;

export declare function sanitizeNames(input: unknown): string[];
export declare function parseNameList(text: string): string[];
export declare function parseNamePools(json: string | null | undefined): NamePools;
export declare function serializeNamePools(pools: NamePools): string;
export declare function pickFromPool(
  pool: string[] | undefined,
  taken: Iterable<string>,
): string | null;
