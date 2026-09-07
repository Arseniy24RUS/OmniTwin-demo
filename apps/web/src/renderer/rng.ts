/** Stable 32-bit hash suitable for deterministic presentation synthesis. */
export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Mulberry32. This is presentation-only and is not used by the scientific model. */
export function createDeterministicRng(seed: number | string): () => number {
  let state = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let output = state;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4294967296;
  };
}

export function deterministicBetween(
  rng: () => number,
  minimum: number,
  maximum: number,
): number {
  return minimum + (maximum - minimum) * rng();
}
