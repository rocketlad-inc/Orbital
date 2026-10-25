// Types for the plain-JS module the WORKER also imports (see shipNames.ts).
export declare const SHIP_NAME_POOLS: Record<string, string[]>;
export declare function randomShipName(cls: string, existingNames: Iterable<string>): string;
