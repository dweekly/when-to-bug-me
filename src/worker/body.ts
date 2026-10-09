// Reading request bodies with a hard byte limit. Kept apart from index.ts so it can be unit-tested
// in Node (index.ts pulls in the Durable Object, which only loads in the Workers runtime).

export class BadRequest extends Error {}

/** Largest JSON body accepted on any POST, in bytes. Covers MAX_RULES and MAX_FACTS at their caps with room. */
export const MAX_BODY_BYTES = 32_000;

/**
 * Read at most MAX_BODY_BYTES of the request body, counted in bytes as they stream in, and stop
 * reading (cancelling the stream) the moment the limit is passed, so an oversized body is never
 * buffered whole.
 */
export async function readLimited(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new BadRequest("request too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BadRequest("request too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

