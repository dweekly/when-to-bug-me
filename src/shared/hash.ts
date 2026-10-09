// Hashing shared by the Worker and the local scripts (both have WebCrypto as globalThis.crypto).

/** A short, stable hash of any JSON value, used for context versions and cache keys. */
export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every level, so equal values always serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The cache key for one model call: everything that can change its answer. The Worker's response
 * cache and the recorded run use the same key, so a recorded answer is replayed only for the
 * identical request.
 */
export async function modelCacheKey(parts: {
  model: string;
  effort: string;
  maxTokens: number;
  promptVersion: string;
  schema: unknown;
  prompt: string;
}): Promise<string> {
  return sha256Hex(parts);
}
