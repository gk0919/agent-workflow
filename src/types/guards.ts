import type { UnknownRecord } from './contracts.js';

/** Narrows untrusted JSON input to a non-array object before property access. */
export const isJsonObject = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Produces a stable message without assuming caught values are Error instances. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Narrows an unknown value to an array of unique strings. */
export const isUniqueStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item): item is string => typeof item === 'string') &&
  new Set(value).size === value.length;
