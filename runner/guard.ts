// The runner's front door (docs/STAGE-9.md): which requests reach the Worker, the runner's own routes,
// or nothing. Pure, so the whole table is unit-tested. The runner is owner-only: no public world.
import { isOwner, sameString } from "../src/worker/liveAuth";

export type Route = "static" | "signin" | "model" | "owner-api" | "runner" | "home";

export interface Incoming {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  cookie: string | undefined;
  authorization: string | undefined;
}

export interface GuardConfig {
  port: number;
  tailnetHost?: string;
  ownerKey: string;
  modelKey: string;
}

export type Verdict = { ok: true; route: Route } | { ok: false; status: number; error: string };

/** The Host values the runner answers to, each with the scheme a browser would use to reach it. */
export function allowedOrigins(c: Pick<GuardConfig, "port" | "tailnetHost">): Map<string, string> {
  const m = new Map<string, string>([
    [`localhost:${c.port}`, `http://localhost:${c.port}`],
    [`127.0.0.1:${c.port}`, `http://127.0.0.1:${c.port}`],
  ]);
  // `tailscale serve` terminates HTTPS on 443 and passes the bare name as Host.
  if (c.tailnetHost) m.set(c.tailnetHost, `https://${c.tailnetHost}`);
  return m;
}

export function classify(path: string): Route | "blocked" {
  if (path === "/" || path === "/app" || path === "/app.html" || path === "/index.html") return "home";
  if (path === "/runner/model") return "model";
  if (path.startsWith("/runner/")) return "runner";
  if (path === "/api/me/login") return "signin";
  if (path === "/api/me" || path.startsWith("/api/me/")) return "owner-api";
  // The public world's routes (the Jordan demo, and every route that can spend) don't exist here.
  if (path.startsWith("/api/") || ["/route", "/answer", "/fact", "/ask", "/parse", "/converse"].includes(path)) return "blocked";
  return "static";
}

const bearerOf = (authorization: string | undefined) => (authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined);

export async function decide(r: Incoming, c: GuardConfig): Promise<Verdict> {
  const origins = allowedOrigins(c);
  const host = r.host?.toLowerCase();
  // An exact Host match: a hostile suffix or a rebinding DNS name never matches.
  if (!host || !origins.has(host)) return { ok: false, status: 421, error: "unknown host" };
  const route = classify(r.path);
  if (route === "blocked") return { ok: false, status: 404, error: "not found" };

  // The Worker's own call back for a model answer: its token, nothing else.
  if (route === "model") {
    const t = bearerOf(r.authorization);
    if (r.method !== "POST" || !t || !sameString(t, c.modelKey)) return { ok: false, status: 403, error: "forbidden" };
    return { ok: true, route };
  }
  if (route === "static" || route === "home") {
    return r.method === "GET" || r.method === "HEAD" ? { ok: true, route } : { ok: false, status: 405, error: "method not allowed" };
  }

  const bearer = bearerOf(r.authorization);
  if (r.method !== "GET" && r.method !== "HEAD") {
    // A browser can't attach a bearer token to another site's request without a CORS preflight, which
    // the runner never grants; so a POST is either the MCP server (bearer) or same-origin (exact Origin).
    if (bearer === undefined && r.origin !== origins.get(host)) return { ok: false, status: 403, error: "cross-origin request refused" };
  }
  if (route === "signin") return r.method === "POST" ? { ok: true, route } : { ok: false, status: 405, error: "method not allowed" };

  const headers = new Headers();
  if (r.authorization) headers.set("authorization", r.authorization);
  if (r.cookie) headers.set("cookie", r.cookie);
  if (!(await isOwner(new Request("http://runner.invalid/", { headers }), c.ownerKey))) {
    return { ok: false, status: 401, error: "sign in with your link first" };
  }
  return { ok: true, route };
}
