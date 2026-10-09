import { describe, expect, it } from "vitest";
import { BadRequest, readLimited } from "../../src/worker/body";

function streamOf(bytes: number, chunk = 4096): { req: Request; pulled: () => number } {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      const n = Math.min(chunk, bytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
  return { req: new Request("https://x.invalid/api/route", { method: "POST", body, duplex: "half" } as RequestInit), pulled: () => sent };
}

describe("readLimited", () => {
  it("stops reading once past the limit, without buffering the whole body", async () => {
    const { req, pulled } = streamOf(10_000_000);
    await expect(readLimited(req, 32_000)).rejects.toBeInstanceOf(BadRequest);
    expect(pulled()).toBeLessThan(200_000);
  });
  it("counts bytes, not UTF-16 units", async () => {
    const text = JSON.stringify({ pad: "é".repeat(20_000) }); // 20k characters, 40k bytes
    const req = new Request("https://x.invalid/", { method: "POST", body: text });
    await expect(readLimited(req, 32_000)).rejects.toBeInstanceOf(BadRequest);
  });
  it("returns a body under the limit intact", async () => {
    const req = new Request("https://x.invalid/", { method: "POST", body: '{"id":"x"}' });
    expect(await readLimited(req, 32_000)).toBe('{"id":"x"}');
  });
});
