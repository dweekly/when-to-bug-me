// Dev preview of the decision briefings (src/page/visuals.ts): bundles a tiny entry that renders every
// fixture decision's visual (the morning's and the retired ones'), unselected and with its first option selected, into
// scripts/visuals-preview.html at a 390px and a 720px column. Output goes to dist/ (gitignored).
// Run with `npm run preview:visuals`, then open scripts/visuals-preview.html in a browser (file:// works,
// because the bundle is a classic script, not a module).
import { build } from "esbuild";

const entry = `
import morning from "./fixtures/decisions.json";
import retired from "./fixtures/retired-decisions.json";
import { renderVisual } from "./src/page/visuals.ts";

for (const width of [390, 720]) {
  const col = document.createElement("section");
  col.className = "col";
  col.style.width = width + "px";
  const h = document.createElement("h1");
  h.textContent = width + "px";
  col.append(h);
  // The retired decisions keep the chart and bar drawings in the preview (docs/STAGE-5.md).
  for (const d of [...morning, ...retired]) {
    if (!d.visual) continue;
    for (const sel of [null, d.options[0].key]) {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.id = d.id;
      const t = document.createElement("h2");
      t.textContent = d.id + " · " + (sel === null ? "nothing selected" : "selected " + sel);
      card.append(t, renderVisual(d.visual, d, sel));
      col.append(card);
    }
  }
  document.getElementById("root").append(col);
}
`;

await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts", sourcefile: "visuals-preview-entry.ts" },
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/visuals-preview.js",
  logLevel: "warning",
});
console.log("built dist/visuals-preview.js; open scripts/visuals-preview.html");
