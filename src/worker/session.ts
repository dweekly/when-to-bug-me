// Who may spend money. A live model call needs a session token, issued by POST /api/session after a
// server-side Turnstile check and signed with HMAC-SHA256 under a key derived from SEAL_KEY. Turnstile
// tokens are single-use and expire in minutes, so one check cannot authorize a whole visit by itself;
// the session token can. Recorded and cached answers cost nothing and need no session.
//
// The gate is active only when TURNSTILE_SECRET is set. Without it (local runs, tests, a deployment
// with no live key) there is nothing paid to protect, and live calls stay off unless a key is set.

/** How long a session token is valid, in seconds. Long enough for an unhurried demo. */
export const SESSION_TTL_SECONDS = 30 * 60;

/** Cloudflare's server-side validation endpoint (developers.cloudflare.com/turnstile/get-started/server-side-validation/). */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function hmacKey(sealKey: string): Promise<CryptoKey> {
  // A separate key for signing, derived from the sealing secret, so one secret serves both purposes
  // without using the same key bytes for two algorithms.
  const material = new TextEncoder().encode(`bugme-session:${sealKey}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueSession(sealKey: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(sealKey), new TextEncoder().encode(`v1.${exp}`));
  return `v1.${exp}.${hex(sig)}`;
}

export async function sessionValid(sealKey: string, token: string | null, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [v, expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (v !== "v1" || !Number.isFinite(exp) || exp * 1000 < now || !/^[0-9a-f]{64}$/.test(sig ?? "")) return false;
  const bytes = new Uint8Array(sig.match(/../g)!.map((x) => parseInt(x, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey(sealKey), bytes, new TextEncoder().encode(`v1.${exp}`));
}

export async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}
