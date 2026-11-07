import type { Criterion } from "./types.ts";

export function hashConfig(criteria: Criterion[]): string {
  const json = JSON.stringify(criteria);
  let h1 = 2166136261;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 16777619);
    h2 = Math.imul(h2 ^ code, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}
