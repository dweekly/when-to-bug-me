// src/worker/seal.ts: the guess is sealed with AES-GCM, bound to the decision, its option keys and the
// context version, so the page cannot read it before answering and a blob cannot be replayed onto
// another decision. seal.ts uses only WebCrypto, which Node 22 provides as globalThis.crypto.

import { describe, expect, it } from "vitest";
import { SEAL_VERSION, SealError, canonicalJson, importSealKey, seal, sha256Hex, unseal } from "../../src/worker/seal";
import type { Sealed } from "../../src/shared/types";

function randomSecret(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s);
}

const payload: Sealed = {
  id: "onsite-flight",
  guess: [
    { option: "A", p: 0.8125 },
    { option: "B", p: 0.1875 },
  ],
  conflicts: [{ option: "A", quoted: "No commitments before 8:30am: Jordan does school drop-off." }],
  send_down: [
    { option: "A", instruction: "Book the 6:05am flight." },
    { option: "B", instruction: "Book the 9:40am flight." },
  ],
};
const binding = { decisionId: "onsite-flight", optionKeys: ["A", "B"], contextVersion: "0123456789abcdef" };

describe("importSealKey", () => {
  it("rejects a missing key and a key of the wrong length", async () => {
    await expect(importSealKey(undefined)).rejects.toBeInstanceOf(SealError);
    await expect(importSealKey("")).rejects.toBeInstanceOf(SealError);
    await expect(importSealKey(randomSecret(16))).rejects.toThrow(/32 bytes/);
  });

  it("accepts 32 bytes in standard or URL-safe base64", async () => {
    await expect(importSealKey(randomSecret())).resolves.toBeDefined();
    const urlSafe = randomSecret().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(importSealKey(urlSafe)).resolves.toBeDefined();
  });
});

describe("seal and unseal", () => {
  it("round-trips the payload", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, binding);
    expect(blob.startsWith(`v${SEAL_VERSION}.${binding.contextVersion}.`)).toBe(true);
    expect(await unseal(key, blob, "onsite-flight", ["A", "B"])).toEqual(payload);
  });

  it("refuses to open with another decision id", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, binding);
    await expect(unseal(key, blob, "berlin-sync", ["A", "B"])).rejects.toBeInstanceOf(SealError);
  });

  it("refuses to open with other option keys, including the same keys reordered", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, binding);
    await expect(unseal(key, blob, "onsite-flight", ["A", "C"])).rejects.toBeInstanceOf(SealError);
    await expect(unseal(key, blob, "onsite-flight", ["A"])).rejects.toBeInstanceOf(SealError);
    await expect(unseal(key, blob, "onsite-flight", ["B", "A"])).rejects.toBeInstanceOf(SealError);
  });

  it("refuses a blob whose clear-text context version was altered", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, binding);
    const parts = blob.split(".");
    parts[1] = "fedcba9876543210";
    await expect(unseal(key, parts.join("."), "onsite-flight", ["A", "B"])).rejects.toBeInstanceOf(SealError);
  });

  it("refuses a tampered ciphertext, another key, and unknown formats", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, binding);
    const parts = blob.split(".");
    const ct = parts[3];
    parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(unseal(key, parts.join("."), "onsite-flight", ["A", "B"])).rejects.toBeInstanceOf(SealError);

    const other = await importSealKey(randomSecret());
    await expect(unseal(other, blob, "onsite-flight", ["A", "B"])).rejects.toBeInstanceOf(SealError);

    await expect(unseal(key, `v${SEAL_VERSION + 1}${blob.slice(2)}`, "onsite-flight", ["A", "B"])).rejects.toBeInstanceOf(SealError);
    await expect(unseal(key, "not a blob", "onsite-flight", ["A", "B"])).rejects.toBeInstanceOf(SealError);
  });

  it("refuses a payload sealed for one id but bound to another", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, { ...binding, decisionId: "berlin-sync" });
    await expect(unseal(key, blob, "berlin-sync", ["A", "B"])).rejects.toThrow(/another decision/);
  });

  it("uses a fresh nonce: sealing the same payload twice gives different blobs", async () => {
    const key = await importSealKey(randomSecret());
    const blobs = new Set<string>();
    for (let i = 0; i < 8; i++) blobs.add(await seal(key, payload, binding));
    expect(blobs.size).toBe(8);
    const nonces = new Set([...blobs].map((b) => b.split(".")[2]));
    expect(nonces.size).toBe(8);
  });

  it("does not carry the guess in plaintext", async () => {
    const key = await importSealKey(randomSecret());
    const blob = await seal(key, payload, binding);
    for (const s of ["guess", '"p"', "0.8125", "0.1875", "drop-off", "9:40am", "send_down"]) {
      expect(blob).not.toContain(s);
    }
    // Nor as base64 of the JSON, which is what a missing encryption step would leave behind.
    const plainB64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(blob).not.toContain(plainB64.slice(0, 16));
  });
});

describe("canonicalJson and sha256Hex", () => {
  it("is independent of object key order at every level", async () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: "s" } };
    const b = { a: { c: "s", d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"s","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });

  it("keeps array order significant and drops undefined fields", async () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(await sha256Hex([1, 2])).not.toBe(await sha256Hex([2, 1]));
  });

  it("hashes to 64 hex characters", async () => {
    expect(await sha256Hex({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
