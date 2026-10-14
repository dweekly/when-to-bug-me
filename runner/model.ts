// Model calls on the person's own Claude Code login (docs/STAGE-9.md): the Worker's `ask()` posts here
// when LOCAL_MODEL_URL is set. Each call is one `claude -p` with every customization off and no
// transcript kept; the prompt goes in on stdin, so it never shows in `ps`. Nothing it says is logged.
import { spawn } from "node:child_process";
import { RUNNER_MAX_MODEL_CALLS, RUNNER_MODEL_TIMEOUT_MS } from "../src/shared/constants";
import { EFFORTS } from "../src/shared/dispatch";

export class ModelCallError extends Error {}

export interface ModelRequest {
  model: string;
  effort: string;
  schema: object;
  prompt: string;
}

const MODEL_RE = /^claude-[a-z0-9-]{1,40}$/;
const MAX_PROMPT_CHARS = 400_000;

export function parseModelRequest(raw: unknown): ModelRequest {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.model !== "string" || !MODEL_RE.test(o.model)) throw new ModelCallError("model must be a Claude model id");
  if (typeof o.effort !== "string" || !(EFFORTS as readonly string[]).includes(o.effort)) throw new ModelCallError("effort is not one Claude Code knows");
  if (!o.schema || typeof o.schema !== "object" || Array.isArray(o.schema)) throw new ModelCallError("schema must be an object");
  if (typeof o.prompt !== "string" || !o.prompt || o.prompt.length > MAX_PROMPT_CHARS) throw new ModelCallError("prompt must be text");
  return { model: o.model, effort: o.effort, schema: o.schema, prompt: o.prompt };
}

/** The arguments, without the prompt (that goes on stdin). */
export function modelArgs(r: Pick<ModelRequest, "model" | "effort" | "schema">): string[] {
  return [
    "-p",
    // The person's CLAUDE.md, hooks, skills, plugins and MCP servers stay out; their login still works.
    "--safe-mode",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools",
    "",
    "--model",
    r.model,
    "--effort",
    r.effort,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(r.schema),
  ];
}

/** Runs at most `max` calls at once; the rest wait their turn. */
export class ModelRunner {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private bin: string,
    private cwd: string,
    private max = RUNNER_MAX_MODEL_CALLS,
    private timeoutMs = RUNNER_MODEL_TIMEOUT_MS,
  ) {}

  async run(r: ModelRequest): Promise<unknown> {
    if (this.running >= this.max) await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
    try {
      return await this.once(r);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private once(r: ModelRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, modelArgs(r), { cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      let done = false;
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        f();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new ModelCallError("the model call timed out")));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        out += d;
      });
      child.on("error", () => finish(() => reject(new ModelCallError("couldn't start claude"))));
      child.on("close", (code) =>
        finish(() => {
          let res: { is_error?: boolean; structured_output?: unknown };
          try {
            res = JSON.parse(out);
          } catch {
            return reject(new ModelCallError(`claude exited ${code} without a result`));
          }
          if (res.is_error || res.structured_output === undefined) return reject(new ModelCallError("claude returned no structured answer"));
          resolve(res.structured_output);
        }),
      );
      child.stdin.on("error", () => {}); // a child that dies early closes stdin; `close` reports it
      child.stdin.end(r.prompt);
    });
  }
}
