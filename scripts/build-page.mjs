// Bundle the page script and copy the explored-option prototypes into public/.
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
mkdirSync("public/variants", { recursive: true });
cpSync("fixtures/variants", "public/variants", { recursive: true });
console.log("built public/app.js and public/variants/");
