// Bundle the app and explainer scripts and copy the explored-option prototypes into public/.
// The fixtures' decisions and recorded run are NOT copied: only the Worker imports those.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

await build({
  entryPoints: ["src/page/main.ts"],
  bundle: true,
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
console.log("built public/app.js, public/landing.js and public/variants/");
