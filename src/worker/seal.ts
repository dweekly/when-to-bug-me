// Sealing keeps Bug Me's guess out of the page until the person has answered. The Worker encrypts the
// hidden part of a routed card with AES-GCM under SEAL_KEY (a Worker secret), with a fresh random
// nonce per seal, and binds it to the decision id, its option keys and the version of the rules and
// facts it was routed under (as GCM additional data, so a blob moved to another decision fails to
// open). The page only ever holds the opaque string. This prevents disclosure before the answer in
// ordinary use; it is not an adversarially blind experiment (the repo and the fixtures are public).

import type { Sealed } from "../shared/types";

export { canonicalJson, sha256Hex } from "../shared/hash";

/** Bumped whenever the sealed payload's shape changes, so old blobs are refused rather than misread. */
export const SEAL_VERSION = 1;

/** AES-GCM nonce length in bytes, per NIST SP 800-38D's recommended 96-bit IV. */
const NONCE_BYTES = 12;

export class SealError extends Error {}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

export async function importSealKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new SealError("SEAL_KEY is not set");
  const raw = unb64(secret);
  if (raw.length !== 32) throw new SealError("SEAL_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** What a sealed blob is bound to. The same values must be presented to open it. */
export interface SealBinding {
  decisionId: string;
  optionKeys: string[];
  /** Hash of the rules and facts the card was routed under. */
  contextVersion: string;
}

function additionalData(b: SealBinding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([SEAL_VERSION, b.decisionId, b.optionKeys, b.contextVersion])) as Uint8Array<ArrayBuffer>;
}

export async function seal(key: CryptoKey, payload: Sealed, binding: SealBinding): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: additionalData(binding) }, key, plain),
  );
  // The context version travels in the clear so the Worker can rebuild the binding; it is a hash, not a secret.
  return `v${SEAL_VERSION}.${binding.contextVersion}.${b64(nonce)}.${b64(ct)}`;
}

export async function unseal(key: CryptoKey, blob: string, decisionId: string, optionKeys: string[]): Promise<Sealed> {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== `v${SEAL_VERSION}`) throw new SealError("unknown sealed format");
  const [, contextVersion, nonce, ct] = parts;
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(nonce), additionalData: additionalData({ decisionId, optionKeys, contextVersion }) },
      key,
      unb64(ct),
    );
  } catch {
    throw new SealError("sealed card does not match this decision");
  }
  const out = JSON.parse(new TextDecoder().decode(plain)) as Sealed;
  if (out.id !== decisionId) throw new SealError("sealed card is for another decision");
  return out;
}
