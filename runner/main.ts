// `npm run runner` (docs/STAGE-9.md): Bug Me on this Mac, owner-only, on 127.0.0.1.
//   --link   print the sign-in link (it carries the owner's key, so treat it like a password)
import { loadConfig, ensureEnvFile } from "./config";
import { startRunner } from "./server";

const cfg = loadConfig();
const signIn = (base: string) => `${base}/me#k=${cfg.ownerKey}`;

if (process.argv.includes("--link")) {
  process.stdout.write(`${signIn(`http://localhost:${cfg.port}`)}\n`);
  if (cfg.tailnetHost) process.stdout.write(`${signIn(`https://${cfg.tailnetHost}`)}\n`);
  process.exit(0);
}

const runner = await startRunner(cfg, ensureEnvFile(cfg.home));
process.stdout.write(
  [
    `Bug Me is running on http://localhost:${cfg.port}/me`,
    cfg.tailnetHost ? `and on your tailnet at https://${cfg.tailnetHost}/me` : `For your phone: tailscale serve --bg ${cfg.port}, then set BUGME_TAILNET_HOST in ${cfg.home}/runner.env`,
    "Sign in on a new device with the link from `npm run runner -- --link`.",
    "",
  ].join("\n"),
);
const stop = () => void runner.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
