// After a deploy, check what the public URL actually serves (issue #49):
//
//   npm run smoke:deployed -- https://bugme.weekly.org
//
// It passes only if the page carries this checkout's commit (so the deploy is the build you meant),
// the queue loads with a routed card for every question (none unavailable), and the app's routes
// (Home, Dispatch, onboarding, review) are in the bundle. Read-only: no model calls, no state changes.

import { execFileSync } from "node:child_process";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: npm run smoke:deployed -- <base url>");
  process.exit(2);
}
const expected = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
// A cache-busting query, so an edge copy of an older bundle can't pass for the new one.
const get = async (path) => {
  const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}smoke=${Date.now()}`);
  return { status: r.status, text: await r.text() };
};

const app = await get("/app");
check(app.status === 200, `GET /app is 200 (got ${app.status})`);
const js = await get("/app.js");
check(js.text.includes(`"${expected}"`), `app.js carries this checkout's commit ${expected}`);
check(!js.text.includes(`"${expected}-dirty"`), "app.js was not built from uncommitted changes");
for (const route of ["dispatch", "welcome", "review"]) check(js.text.includes(`"${route}"`), `app.js has the ${route} view`);

const q = await get("/api/queue");
check(q.status === 200, `GET /api/queue is 200 (got ${q.status})`);
if (q.status === 200) {
  const data = JSON.parse(q.text);
  const unavailable = data.cards.filter((c) => "unavailable" in c);
  check(data.cards.length === data.decisions.length, `a card for every question (${data.cards.length} of ${data.decisions.length})`);
  check(unavailable.length === 0, `no question unrouted${unavailable.length ? ` (${unavailable.map((c) => `${c.id}: ${c.unavailable}`).join("; ")})` : ""}`);
  console.log(`     mode: ${data.mode}`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\n${base} serves ${expected}.`);
