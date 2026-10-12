// Who may use the live queue (docs/STAGE-7.md): the one owner, proven by the LIVE_TOKEN secret. The MCP
// server sends it as a bearer token; a browser trades it once for a cookie holding an HMAC of it, so the
// token itself is never stored in the browser and rotating the secret signs every device out.
// Every comparison is constant-time. Pure WebCrypto, so the unit tests run it in Node.

export const OWNER_COOKIE = "bugme_owner";
const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;
/** A key shorter than this is refused outright, so a weak secret can't be set by accident. */
export const MIN_TOKEN_CHARS = 32;

const enc = new TextEncoder();

/** Compare two strings in time that depends only on their lengths. */
export function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The cookie value for a key, HMAC-SHA-256(liveKey, "owner-cookie") in hex. */
export async function cookieValue(liveKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(liveKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode("owner-cookie"));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function usableToken(liveKey: string | undefined): liveKey is string {
  return typeof liveKey === "string" && liveKey.length >= MIN_TOKEN_CHARS;
}

/** Whether a request comes from the owner: a bearer token or the owner cookie. */
export async function isOwner(req: Request, liveKey: string | undefined): Promise<boolean> {
  if (!usableToken(liveKey)) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return sameString(auth.slice(7).trim(), liveKey);
  const cookie = readCookie(req.headers.get("cookie"), OWNER_COOKIE);
  return cookie !== null && sameString(cookie, await cookieValue(liveKey));
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** The Set-Cookie header for a signed-in browser. */
export async function ownerCookie(liveKey: string): Promise<string> {
  return `${OWNER_COOKIE}=${await cookieValue(liveKey)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
}
