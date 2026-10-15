// Bundle the app and explainer scripts and copy the explored-option prototypes into public/.
// The fixtures' decisions and recorded run are NOT copied: only the Worker imports those.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";

// The commit the page is built from, shown on Record and checked by `npm run smoke:deployed` (issue
// #49), so the public URL says which build it serves. "-dirty" when uncommitted changes went in.
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const sha = git("rev-parse", "--short=7", "HEAD");
const BUILD = sha ? `${sha}${git("status", "--porcelain", "--untracked-files=no") ? "-dirty" : ""}` : "unknown";

await build({
  entryPoints: ["src/page/main.ts"],
  bundle: true,
  define: { __BUILD__: JSON.stringify(BUILD) },
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: "public/app.js",
});
// The explainer at "/": its own small bundle (it shares only the tour catalog and types with the app).
await build({
  entryPoints: ["src/page/landing.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: "public/landing.js",
});
mkdirSync("public/variants", { recursive: true });
// The tour engine's stylesheet, linked from app.html; our dark theme overrides it in style.css.
cpSync("node_modules/driver.js/dist/driver.css", "public/driver.css");
cpSync("fixtures/variants", "public/variants", { recursive: true });
console.log(`built public/app.js (build ${BUILD}), public/landing.js and public/variants/`);
