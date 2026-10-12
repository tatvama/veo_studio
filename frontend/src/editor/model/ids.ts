/** Short random ids for document objects ("c_k3j9x2ab"). Tests can make them deterministic with `seedIds`. */

let counter = 0;
let seeded: number | null = null;

function rand(): string {
  if (seeded !== null) {
    seeded = (seeded * 1103515245 + 12345) & 0x7fffffff;
    return seeded.toString(36).padStart(6, "0").slice(-6);
  }
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const a = new Uint32Array(2);
    c.getRandomValues(a);
    return (a[0].toString(36) + a[1].toString(36)).slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

/** A new id with a type prefix: uid("c") → "c_k3j9x2ab". */
export function uid(prefix: string): string {
  counter = (counter + 1) % 1296;
  return `${prefix}_${rand()}${counter.toString(36).padStart(2, "0")}`;
}

/** Deterministic ids (tests). Pass null to go back to random ones. */
export function seedIds(seed: number | null) { seeded = seed; counter = 0; }
