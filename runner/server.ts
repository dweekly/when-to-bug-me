// The runner (docs/STAGE-9.md): the Worker under wrangler on loopback, and a front server that guards
// it, answers the Worker's model calls on the person's Claude login, and launches briefs as background
// Claude Code sessions.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { parseMcpList, skillNames } from "../mcp/bugme.mjs";
import { RUNNER_HEADER, RUNNER_MCP_LIST_TIMEOUT_MS, RUNNER_STALE_LAUNCH_MS } from "../src/shared/constants";
import { BRIEF_ID_RE } from "../src/worker/live";
import { BUGME_PREFIX, type Brief, type Catalog, type Launch, REPO_NAME_RE, allTicked } from "../src/shared/dispatch";
import type { RunnerConfig } from "./config";
import { decide } from "./guard";
import { LaunchError, backgroundId, launchArgs, listRepos, resolveRepo, run, sessionName, sessions, trustedDirs, walkPrompt, writeMcpConfig, writeWalk } from "./launch";
import { ModelCallError, ModelRunner, parseModelRequest } from "./model";

const MAX_BODY_BYTES = 1024 * 1024;
/** Headers a proxy in front (tailscale serve) may add; the Worker never sees them, so nothing trusts them. */
const DROP = /^(host|connection|keep-alive|transfer-encoding|forwarded|x-forwarded-.*|x-real-ip|cf-.*|tailscale-.*|content-length)$/i;

export interface Runner {
  server: Server;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startRunner(cfg: RunnerConfig, envFile: string): Promise<Runner> {
  const workerUrl = `http://127.0.0.1:${cfg.workerPort}`;
  const scratch = join(cfg.home, "model");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const mcpConfig = join(cfg.home, "mcp.json");
  writeMcpConfig(mcpConfig, cfg.repoRoot, cfg.port, cfg.ownerKey);
  const models = new ModelRunner(cfg.claudeBin, scratch);

  // Started directly (not through npx), so a SIGTERM reaches wrangler, which stops its workerd; and in
  // the runner's own process group, so whatever stops the runner's group stops it too.
  const worker: ChildProcess = spawn(
    join(cfg.repoRoot, "node_modules", ".bin", "wrangler"),
    [
      "dev",
      "--ip", "127.0.0.1",
      "--port", String(cfg.workerPort),
      "--inspector-ip", "127.0.0.1",
      "--inspector-port", String(cfg.port + 2),
      "--persist-to", join(cfg.home, "state"),
      "--env-file", envFile,
      "--var", `LOCAL_MODEL_URL:http://127.0.0.1:${cfg.port}/runner/model`,
      "--show-interactive-dev-session=false",
      ...(process.env.BUGME_RUNNER_FAKE_MODEL ? ["--var", "FAKE_MODEL:1"] : []),
    ],
    { cwd: cfg.repoRoot, stdio: ["ignore", process.env.BUGME_RUNNER_LOG ? "inherit" : "ignore", process.env.BUGME_RUNNER_LOG ? "inherit" : "ignore"] },
  );
  const stopWorker = () => {
    try {
      worker.kill("SIGTERM");
    } catch {
      // already gone
    }
  };

  process.on("exit", stopWorker);

  /** The Worker's owner API, as the owner. */
  async function owner<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const r = await fetch(`${workerUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { [RUNNER_HEADER]: cfg.modelKey, authorization: `Bearer ${cfg.ownerKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: (await r.json()) as T };
  }
  const briefsAndCatalog = async () => (await owner<{ briefs: Brief[]; catalog: Catalog }>("/api/me/briefs")).data;
  const record = (id: string, l: Omit<Launch, "at">) => owner<{ brief: Brief; ok: boolean }>(`/api/me/briefs/${id}/launch`, l);

  for (let i = 0; ; i++) {
    if (await fetch(`${workerUrl}/api/me/briefs`, { headers: { [RUNNER_HEADER]: cfg.modelKey, authorization: `Bearer ${cfg.ownerKey}` } }).then((r) => r.ok, () => false)) break;
    if (i > 90 || worker.exitCode !== null) {
      stopWorker();
      throw new Error("the Worker didn't start (run with BUGME_RUNNER_LOG=1 to see why)");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  /** Read the tools as Claude Code sees them in `cwd`. */
  async function mcpList(cwd: string) {
    return parseMcpList(await run(cfg.claudeBin, ["mcp", "list"], cwd, RUNNER_MCP_LIST_TIMEOUT_MS));
  }
  let catalogNote = "reading your tools…";
  async function refreshCatalog(): Promise<void> {
    try {
      const catalog = { servers: await mcpList(cfg.home), skills: skillNames() };
      const r = await owner("/api/me/catalog", catalog);
      catalogNote = r.status === 200 ? "" : "Bug Me refused the tool list";
    } catch {
      // The last catalog stays: a failed read never erases it.
      catalogNote = "couldn't read your tools; showing the last list";
    }
  }

  /**
   * A launch left "launching" (the runner stopped mid-launch, or a lost response): its session is found
   * by name, or the launch is marked failed so it can be tried again.
   */
  async function reconcile(briefs: Brief[], force = false): Promise<void> {
    const stale = briefs.filter((b) => b.launch?.state === "launching" && (force || Date.now() - Date.parse(b.launch.at) > RUNNER_STALE_LAUNCH_MS));
    if (!stale.length) return;
    let live: Awaited<ReturnType<typeof sessions>> = [];
    try {
      live = await sessions(cfg.claudeBin, cfg.home);
    } catch {
      return; // can't tell; leave it for the next look
    }
    for (const b of stale) {
      const s = live.find((x) => x.name === sessionName(b.id));
      await record(b.id, s ? { state: "running", repo: b.launch!.repo, session_id: s.id } : { state: "failed", repo: b.launch!.repo, error: "the launch was interrupted" });
    }
  }

  async function launch(briefId: string, repo: string): Promise<{ status: number; body: unknown }> {
    if (!BRIEF_ID_RE.test(briefId) || !REPO_NAME_RE.test(repo)) return { status: 400, body: { error: "unknown brief or repo" } };
    const { briefs, catalog } = await briefsAndCatalog();
    const b = briefs.find((x) => x.id === briefId);
    if (!b) return { status: 404, body: { error: "unknown brief" } };
    // A reservation younger than RUNNER_STALE_LAUNCH_MS may still be starting: it stays protected.
    if (b.launch?.state === "launching") await reconcile([b]);
    if (!allTicked(b)) return { status: 409, body: { error: "Tick every “You first” item first." } };
    let path: string;
    try {
      path = resolveRepo(cfg.devRoot, repo, trustedDirs(cfg.claudeJson));
    } catch (e) {
      return { status: 409, body: { error: e instanceof LaunchError ? e.message : "that repo can't be used" } };
    }
    // The tools as a session in that repo will see them (project servers included).
    const needed = b.tools_needed.filter((p) => p !== BUGME_PREFIX);
    if (needed.length) {
      let here: { prefix: string; name: string; status: string }[];
      try {
        here = await mcpList(path);
      } catch {
        return { status: 502, body: { error: "couldn't read the tools in that repo" } };
      }
      const missing = needed.filter((p) => here.find((s) => s.prefix === p)?.status !== "connected");
      if (missing.length) {
        const names = missing.map((p) => here.find((s) => s.prefix === p)?.name ?? catalog.servers.find((s) => s.prefix === p)?.name ?? p);
        return { status: 409, body: { error: `Not connected in ${repo}: ${names.join(", ")}.` } };
      }
    }
    const reserved = await record(b.id, { state: "launching", repo });
    if (reserved.status === 409) return { status: 200, body: { launch: reserved.data.brief.launch, existing: true } };
    if (reserved.status !== 200) return { status: 502, body: { error: "Bug Me couldn't record the launch" } };
    let id: string | undefined;
    try {
      id = backgroundId(await run(cfg.claudeBin, launchArgs(b, catalog, mcpConfig), path));
    } catch {
      id = undefined;
    }
    if (!id) {
      await record(b.id, { state: "failed", repo, error: "the session didn't start" });
      return { status: 502, body: { error: "The session didn't start." } };
    }
    const started = await record(b.id, { state: "running", repo, session_id: id });
    return { status: 200, body: { launch: started.data.brief.launch } };
  }

  /**
   * Pass a request to the Worker. node:http rather than fetch: fetch gives up waiting for response
   * headers after 300 s, and an owner ask through the runner can take two model calls of up to 180 s.
   */
  async function proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.test(k) && typeof v === "string") headers[k] = v;
    headers[RUNNER_HEADER] = cfg.modelKey;
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    if (body) headers["content-length"] = String(body.length);
    await new Promise<void>((resolve, reject) => {
      const up = httpRequest({ host: "127.0.0.1", port: cfg.workerPort, method: req.method, path, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on("end", resolve);
        r.on("error", reject);
      });
      up.on("error", reject);
      up.end(body);
    });
  }


  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://runner.invalid");
      const v = await decide(
        { method: req.method ?? "GET", path: url.pathname, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, authorization: req.headers.authorization },
        { port: cfg.port, tailnetHost: cfg.tailnetHost, ownerKey: cfg.ownerKey, modelKey: cfg.modelKey },
      );
      if (!v.ok) return send(res, v.status, { error: v.error });
      if (v.route === "home") {
        res.writeHead(302, { location: "/me" });
        return res.end();
      }
      if (v.route === "model") {
        try {
          return send(res, 200, { output: await models.run(parseModelRequest(JSON.parse((await readBody(req)).toString("utf8")))) });
        } catch (e) {
          // Code's words only: nothing the model or the CLI said.
          return send(res, 502, { error: e instanceof ModelCallError ? e.message : "bad request" });
        }
      }
      if (v.route === "runner") {
        if (url.pathname === "/runner/status" && req.method === "GET") {
          const { briefs } = await briefsAndCatalog();
          await reconcile(briefs);
          let live: Awaited<ReturnType<typeof sessions>> | null = null;
          try {
            live = await sessions(cfg.claudeBin, cfg.home);
          } catch {
            live = null;
          }
          return send(res, 200, { runner: true, repos: listRepos(cfg.devRoot, trustedDirs(cfg.claudeJson)), sessions: live, catalog_note: catalogNote });
        }
        if (url.pathname === "/runner/launch" && req.method === "POST") {
          let b: Record<string, unknown>;
          try {
            b = JSON.parse((await readBody(req)).toString("utf8"));
          } catch {
            return send(res, 400, { error: "expected JSON" });
          }
          const r = await launch(String(b.brief_id ?? ""), String(b.repo ?? ""));
          return send(res, r.status, r.body);
        }
        if (url.pathname === "/runner/walk" && req.method === "POST") {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse((await readBody(req)).toString("utf8"));
          } catch {
            return send(res, 400, { error: "expected JSON" });
          }
          const id = String(body.brief_id ?? "");
          const item = Number(body.item);
          if (!BRIEF_ID_RE.test(id) || !Number.isInteger(item)) return send(res, 400, { error: "unknown brief or item" });
          const b = (await briefsAndCatalog()).briefs.find((x) => x.id === id);
          if (!b?.prerequisites[item]) return send(res, 404, { error: "unknown brief or item" });
          const script = writeWalk(join(cfg.home, "walk", `${id}-${item}`), cfg.claudeBin, walkPrompt(b, item));
          try {
            await run(cfg.openBin, ["-a", "Terminal", script], cfg.home);
          } catch {
            return send(res, 502, { error: "Couldn't open Terminal on the Mac." });
          }
          return send(res, 200, { ok: true });
        }
        if (url.pathname === "/runner/catalog" && req.method === "POST") {
          await refreshCatalog();
          return send(res, 200, { ok: !catalogNote, note: catalogNote });
        }
        return send(res, 404, { error: "not found" });
      }
      return proxy(req, res, `${url.pathname}${url.search}`);
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, "127.0.0.1", resolve);
    });
  } catch (e) {
    // The port is taken, say: the Worker started for nothing, so it goes too.
    models.stopAll();
    stopWorker();
    throw e;
  }
  void refreshCatalog();
  void briefsAndCatalog().then((x) => reconcile(x.briefs), () => {});

  return {
    server,
    close: async () => {
      // Model helpers stop with the runner; launched work sessions are the person's and keep running.
      models.stopAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      stopWorker();
    },
  };
}
