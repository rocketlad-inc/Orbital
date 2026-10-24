// Types for the plain-JS module (plain JS so the worker can import it).
export const AI_HOSTS: Array<[RegExp, string]>;
export const AI_SOURCES: Set<string>;
export function aiSourceName(token: string | null | undefined): string | null;
export function isAiSource(source: string): boolean;
export const AI_GROUP: string;
